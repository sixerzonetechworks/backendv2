/**
 * Offline Booking Controller
 * Handles walk-in/offline bookings by admin (no payment processing)
 * Uses the same APIs and flow as online bookings
 */

import db from '../models/index.js';
import { Op } from 'sequelize';

const { Ground, Booking } = db;

const ALLOWED_PAYMENT_STATUSES = ['pending', 'processing', 'paid', 'failed', 'refunded'];
const ALLOWED_BOOKING_TYPES = ['online', 'offline'];
const SLOT_BLOCKING_STATUSES = ['pending', 'processing', 'paid'];
const IST_OFFSET_MINUTES = 330;

/**
 * Create offline booking (admin only)
 * Same validation and flow as online bookings, but status is set to 'paid' directly
 * and bookingType is marked as 'offline'
 */
export const createOfflineBooking = async (req, res) => {
  try {
    const { name, phone, email, groundId, date, startHour, duration = 1, totalAmount } = req.body;

    // Validation
    if (!name || !phone || !email || !groundId || !date || startHour === undefined) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Verify ground exists
    const ground = await Ground.findByPk(groundId);
    if (!ground) {
      return res.status(404).json({
        success: false,
        message: 'Ground not found'
      });
    }

    const parsedTimes = buildBookingTimes(date, startHour, duration);
    if (!parsedTimes.success) {
      return res.status(400).json({
        success: false,
        message: parsedTimes.message
      });
    }
    const { startTime, endTime } = parsedTimes.data;

    // Check for existing paid bookings (same logic as online bookings)
    const existingBooking = await Booking.findOne({
      where: {
        startTime: {
          [Op.lt]: endTime
        },
        endTime: {
          [Op.gt]: startTime
        },
        paymentStatus: 'paid',
        groundId: {
          [Op.in]: getRelatedGrounds(groundId)
        }
      }
    });

    if (existingBooking) {
      return res.status(400).json({
        success: false,
        message: 'This slot is already booked'
      });
    }

    // Create offline booking with 'paid' status and 'offline' bookingType
    const booking = await Booking.create({
      name,
      phone,
      email,
      groundId,
      startTime,
      endTime,
      duration,
      totalAmount: totalAmount || 0,
      paymentStatus: 'paid',
      bookingType: 'offline', // Mark as offline booking
      paymentMethod: 'cash',
      paymentCompletedAt: new Date()
    });

    // Fetch ground details for response
    const groundDetails = await Ground.findByPk(groundId);

    console.log(`💵 Offline booking: ID ${booking.id} | ${groundDetails.name} | ${duration}h | ₹${totalAmount || 0} | ${name}`);

    res.json({
      success: true,
      message: 'Offline booking created successfully',
      booking: {
        id: booking.id,
        name: booking.name,
        phone: booking.phone,
        email: booking.email,
        groundId: booking.groundId,
        groundName: groundDetails.name,
        startTime: booking.startTime,
        endTime: booking.endTime,
        duration: booking.duration,
        totalAmount: booking.totalAmount,
        paymentStatus: booking.paymentStatus,
        bookingType: booking.bookingType
      }
    });

  } catch (error) {
    console.error('Offline booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create offline booking',
      error: error.message
    });
  }
};

/**
 * Get related grounds for conflict checking
 * Mega_Ground (id=3) conflicts with G1 (id=1) and G2 (id=2)
 */
function getRelatedGrounds(groundId) {
  const relatedMap = {
    1: [1, 3], // G1 is related to G1 and Mega_Ground
    2: [2, 3], // G2 is related to G2 and Mega_Ground
    3: [1, 2, 3] // Mega_Ground is related to all
  };
  return relatedMap[parseInt(groundId)] || [parseInt(groundId)];
}

/**
 * Update booking (admin only)
 * Allows admin to edit existing booking records.
 */
export const updateBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      phone,
      email,
      groundId,
      date,
      startHour,
      endHour,
      startHour12,
      startPeriod,
      endHour12,
      endPeriod,
      duration = 1,
      totalAmount,
      paymentStatus,
      paymentMethod,
      bookingType
    } = req.body;

    const booking = await Booking.findByPk(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!name || !phone || !email || !groundId || !date || startHour === undefined) {
      return res.status(400).json({
        success: false,
        message: 'name, phone, email, groundId, date and startHour are required'
      });
    }

    const ground = await Ground.findByPk(groundId);
    if (!ground) {
      return res.status(404).json({
        success: false,
        message: 'Ground not found'
      });
    }

    const resolvedHours = resolveBookingHours({
      startHour,
      endHour,
      startHour12,
      startPeriod,
      endHour12,
      endPeriod,
      duration
    });
    if (!resolvedHours.success) {
      return res.status(400).json({
        success: false,
        message: resolvedHours.message
      });
    }

    const parsedTimes = buildBookingTimes(
      date,
      resolvedHours.data.startHour,
      resolvedHours.data.duration
    );
    if (!parsedTimes.success) {
      return res.status(400).json({
        success: false,
        message: parsedTimes.message
      });
    }
    const { startTime, endTime } = parsedTimes.data;

    const normalizedStatus = (paymentStatus || booking.paymentStatus).toLowerCase();
    if (!ALLOWED_PAYMENT_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid paymentStatus. Allowed: ${ALLOWED_PAYMENT_STATUSES.join(', ')}`
      });
    }

    const normalizedType = (bookingType || booking.bookingType || 'offline').toLowerCase();
    if (!ALLOWED_BOOKING_TYPES.includes(normalizedType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid bookingType. Allowed: ${ALLOWED_BOOKING_TYPES.join(', ')}`
      });
    }

    // Active bookings occupy slots. Ensure updates do not overlap with another active booking.
    if (SLOT_BLOCKING_STATUSES.includes(normalizedStatus)) {
      const existingBooking = await Booking.findOne({
        where: {
          id: { [Op.ne]: booking.id },
          startTime: { [Op.lt]: endTime },
          endTime: { [Op.gt]: startTime },
          paymentStatus: { [Op.in]: SLOT_BLOCKING_STATUSES },
          groundId: { [Op.in]: getRelatedGrounds(groundId) }
        },
        include: [
          {
            model: Ground,
            as: 'ground',
            attributes: ['id', 'name']
          }
        ]
      });

      if (existingBooking) {
        const conflictGround = existingBooking.ground?.name || `Ground #${existingBooking.groundId}`;
        return res.status(409).json({
          success: false,
          message: `Slot conflict: ${conflictGround} is already booked for the selected date/time (booking #${existingBooking.id}).`
        });
      }
    }

    await booking.update({
      name: String(name).trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      groundId: parseInt(groundId),
      startTime,
      endTime,
      duration: resolvedHours.data.duration,
      totalAmount: Number(totalAmount ?? booking.totalAmount ?? 0),
      paymentStatus: normalizedStatus,
      paymentMethod: paymentMethod || booking.paymentMethod || (normalizedType === 'offline' ? 'cash' : null),
      bookingType: normalizedType,
      paymentCompletedAt: normalizedStatus === 'paid'
        ? (booking.paymentCompletedAt || new Date())
        : booking.paymentCompletedAt
    });

    const updatedBooking = await Booking.findByPk(booking.id, {
      include: [
        {
          model: Ground,
          as: 'ground',
          attributes: ['id', 'name', 'description']
        }
      ]
    });

    res.json({
      success: true,
      message: 'Booking updated successfully',
      booking: updatedBooking
    });
  } catch (error) {
    console.error('Update booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking',
      error: error.message
    });
  }
};

function resolveBookingHours({
  startHour,
  endHour,
  startHour12,
  startPeriod,
  endHour12,
  endPeriod,
  duration
}) {
  let parsedStartHour = Number(startHour);
  let parsedEndHour = Number(endHour);
  const has12HourInputs =
    startHour12 !== undefined &&
    startPeriod !== undefined &&
    endHour12 !== undefined &&
    endPeriod !== undefined;

  if (has12HourInputs) {
    const startFrom12 = convert12To24(startHour12, startPeriod);
    if (!startFrom12.success) return startFrom12;
    const endFrom12 = convert12To24(endHour12, endPeriod);
    if (!endFrom12.success) return endFrom12;
    parsedStartHour = startFrom12.hour24;
    parsedEndHour = endFrom12.hour24;
  }

  if (Number.isInteger(parsedStartHour) && Number.isInteger(parsedEndHour)) {
    const normalizedDuration =
      parsedEndHour === parsedStartHour
        ? 24
        : ((parsedEndHour - parsedStartHour + 24) % 24);

    if (normalizedDuration < 1 || normalizedDuration > 24) {
      return {
        success: false,
        message: 'Invalid time range. Duration must be between 1 and 24 hours'
      };
    }

    return {
      success: true,
      data: {
        startHour: parsedStartHour,
        duration: normalizedDuration
      }
    };
  }

  const parsedDuration = Number(duration);
  if (!Number.isInteger(parsedStartHour) || parsedStartHour < 0 || parsedStartHour > 23) {
    return {
      success: false,
      message: 'startHour must be an integer between 0 and 23'
    };
  }

  if (!Number.isInteger(parsedDuration) || parsedDuration < 1 || parsedDuration > 24) {
    return {
      success: false,
      message: 'duration must be an integer between 1 and 24'
    };
  }

  return {
    success: true,
    data: {
      startHour: parsedStartHour,
      duration: parsedDuration
    }
  };
}

function convert12To24(hour12, period) {
  const parsedHour12 = Number(hour12);
  const normalizedPeriod = String(period || '').toUpperCase();

  if (!Number.isInteger(parsedHour12) || parsedHour12 < 1 || parsedHour12 > 12) {
    return {
      success: false,
      message: 'Hour must be between 1 and 12 for AM/PM format'
    };
  }

  if (!['AM', 'PM'].includes(normalizedPeriod)) {
    return {
      success: false,
      message: 'Period must be AM or PM'
    };
  }

  if (normalizedPeriod === 'AM') {
    return { success: true, hour24: parsedHour12 === 12 ? 0 : parsedHour12 };
  }

  return { success: true, hour24: parsedHour12 === 12 ? 12 : parsedHour12 + 12 };
}

function buildBookingTimes(date, startHour, duration) {
  const parsedStartHour = Number(startHour);
  const parsedDuration = Number(duration);
  const [year, month, day] = String(date).split('-').map(Number);

  if (!year || !month || !day) {
    return {
      success: false,
      message: 'Invalid date format. Use YYYY-MM-DD'
    };
  }

  if (!Number.isInteger(parsedStartHour) || parsedStartHour < 0 || parsedStartHour > 23) {
    return {
      success: false,
      message: 'startHour must be an integer between 0 and 23'
    };
  }

  if (!Number.isInteger(parsedDuration) || parsedDuration < 1 || parsedDuration > 24) {
    return {
      success: false,
      message: 'duration must be an integer between 1 and 24'
    };
  }

  // Build timestamp from IST midnight using fixed offset math (timezone-safe).
  const istMidnightUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - (IST_OFFSET_MINUTES * 60 * 1000);
  const startTime = new Date(istMidnightUtcMs + (parsedStartHour * 60 * 60 * 1000));
  const endTime = new Date(startTime.getTime() + (parsedDuration * 60 * 60 * 1000));

  return {
    success: true,
    data: { startTime, endTime }
  };
}

export default {
  createOfflineBooking,
  updateBooking
};
