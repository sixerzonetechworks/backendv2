// ============================================================================
// UPDATE GROUND PRICING (ADMIN)
// ============================================================================

/**
 * Update pricing for a ground (admin only)
 * @route PUT /api/grounds/:id/pricing
 * @param {number} req.params.id - Ground ID
 * @param {Object} req.body.pricing - Pricing JSON object
 * @returns {Object} Updated ground
 */
export const updateGroundPricing = async (req, res) => {
  try {
    const groundId = req.params.id;
    const { pricing } = req.body;
    if (!pricing || typeof pricing !== 'object') {
      return res.status(400).json({ error: 'Valid pricing object required' });
    }
    const ground = await Ground.findByPk(groundId);
    if (!ground) {
      return res.status(404).json({ error: 'Ground not found' });
    }
    ground.pricing = pricing;
    await ground.save();
    res.json({ success: true, ground });
  } catch (error) {
    console.error('Error updating ground pricing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
/**
 * ============================================================================
 * GROUND CONTROLLER
 * ============================================================================
 * 
 * Handles availability checking for grounds, slots, and dates.
 * 
 * Key Features:
 * - Dynamic availability calculation for next 45 days
 * - Related ground conflict detection (Mega_Ground ↔ G1/G2)
 * - Only considers 'paid' bookings for availability
 * - Real-time slot availability based on current time
 * - 30-minute buffer for ongoing slots
 * 
 * ============================================================================
 */

import db from '../models/index.js';

const { Ground, Booking, BlockedSlot } = db;

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Build start of IST day (YYYY-MM-DD 00:00 IST) as UTC Date */
function getIstDayStart(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  if (!year || !month || !day) return null;
  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - IST_OFFSET_MS;
  return new Date(utcMs);
}

/** Build requested start/end for a slot in IST (date YYYY-MM-DD, hour 0-23) */
function buildIstSlotBounds(dateString, hour) {
  const start = getIstDayStart(dateString);
  if (!start || isNaN(start.getTime())) return null;
  const startMs = start.getTime() + (hour * 60 * 60 * 1000);
  const endMs = startMs + (60 * 60 * 1000);
  return { requestedStartTime: new Date(startMs), requestedEndTime: new Date(endMs) };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if hour is during closed hours (1 AM - 6 AM)
 * Turf is closed from 1:00 AM to 6:00 AM
 * 
 * @param {number} hour - Hour in 24-hour format (0-23)
 * @returns {boolean} True if hour is closed
 */
function isClosedHour(hour) {
  return hour >= 1 && hour < 6;
}

/**
 * Get formatted slot label for display
 * 
 * Converts 24-hour format to 12-hour format with AM/PM
 * Example: Hour 14 → "2:00 PM to 3:00 PM"
 * 
 * @param {number} hour - Hour in 24-hour format (0-23)
 * @returns {string} Formatted slot label
 */
function getSlotLabel(hour) {
  const startHour = hour % 12 === 0 ? 12 : hour % 12;
  const endHour = (hour + 1) % 12 === 0 ? 12 : (hour + 1) % 12;
  const startAmPm = hour < 12 ? 'AM' : 'PM';
  const endAmPm = (hour + 1) < 12 || (hour + 1) === 24 ? 'AM' : 'PM';
  
  return `${startHour}:00 ${startAmPm} to ${endHour}:00 ${endAmPm}`;
}

/**
 * Get related grounds for conflict detection
 * 
 * Ground Relationships:
 * - Mega_Ground = G1 + G2 (booking Mega_Ground blocks both)
 * - G1 or G2 booked → Mega_Ground unavailable
 * - G1 and G2 independent of each other
 * 
 * @param {string} groundName - Name of the ground (G1, G2, or Mega_Ground)
 * @returns {string[]} Array of related ground names
 */
function getRelatedGrounds(groundName) {
  if (groundName === 'Mega_Ground') return ['G1', 'G2'];
  if (groundName === 'G1' || groundName === 'G2') return ['Mega_Ground'];
  return [];
}

/**
 * Check if a time range overlaps with a booking
 * 
 * Overlap Logic:
 * - Booking starts before requested end time
 * - Booking ends after requested start time
 * 
 * @param {Object} booking - Booking object with startTime and duration
 * @param {Date} requestedStart - Requested start time
 * @param {Date} requestedEnd - Requested end time
 * @returns {boolean} True if overlap exists
 */
function checkTimeOverlap(booking, requestedStart, requestedEnd) {
  const bookingStart = new Date(booking.startTime);
  const bookingEnd = booking.endTime ? new Date(booking.endTime) : new Date(bookingStart.getTime() + (booking.duration || 1) * 60 * 60 * 1000);
  return bookingStart < requestedEnd && bookingEnd > requestedStart;
}

/**
 * Normalize slot label for comparison (admin may use " - " or " to ")
 * @param {string} s - Slot string e.g. "4:00 PM - 5:00 PM" or "4:00 PM to 5:00 PM"
 * @returns {string} Normalized form
 */
function normalizeSlotLabel(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/\s*-\s*/g, ' to ').trim();
}

/**
 * Check if a time slot is blocked by admin
 * 
 * @param {Array} blockedSlots - Array of blocked slot records
 * @param {string} timeSlot - Time slot string (e.g., "9:00 AM to 10:00 AM" or "9:00 AM - 10:00 AM")
 * @param {number} groundId - Ground ID to check (null checks all grounds)
 * @returns {boolean} True if slot is blocked
 */
function isSlotBlocked(blockedSlots, timeSlot, groundId) {
  const normalized = normalizeSlotLabel(timeSlot);
  if (!normalized) return false;
  return blockedSlots.some(block => {
    const appliesToGround = block.groundId === null || block.groundId === groundId;
    const matchesTimeSlot = normalizeSlotLabel(block.timeSlot) === normalized;
    return appliesToGround && matchesTimeSlot && block.isActive;
  });
}

/**
 * Calculate pricing for a ground based on date and time
 * 
 * Pricing Rules:
 * - Weekday: Monday to Friday
 * - Weekend: Saturday to Sunday
 * - First Half: 6:00 AM (6) to 6:00 PM (18) - hours 6-17
 * - Second Half: 6:00 PM (18) to 6:00 AM (6) - hours 18-23 and 0-5
 * 
 * @param {Object} ground - Ground object with pricing JSON
 * @param {Date} date - Date of booking
 * @param {number} hour - Hour of booking (0-23)
 * @returns {number} Price for the slot
 */
function calculatePrice(ground, date, hour) {
  const pricing = ground.pricing;
  
  // Determine if weekday or weekend
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const isFirstHalf = hour >= 6 && hour < 18;
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6) || (dayOfWeek === 5 && !isFirstHalf);
  
  // Select appropriate pricing key
  let pricingKey;
  if (isWeekend) {
    pricingKey = isFirstHalf ? 'Weekend_first_half' : 'Weekend_second_half';
  } else {
    pricingKey = isFirstHalf ? 'Weekday_first_half' : 'Weekday_second_half';
  }
  
  return pricing[pricingKey] || 1000; // Default to 1000 if key not found
}

// ============================================================================
// CONTROLLER FUNCTIONS
// ============================================================================

/**
 * Get available dates for booking (next 45 days)
 * 
 * Returns dates grouped by month with enabled/disabled flag.
 * A date is enabled if at least one slot has at least one ground available.
 * 
 * Algorithm:
 * 1. Generate dates for next 45 days
 * 2. For each date, check all 24 hours
 * 3. For each hour, check if any ground is available
 * 4. If at least one hour has available ground → date enabled
 * 5. Group by month (YYYY-MM) for UI display
 * 
 * Special Cases:
 * - Today: Only future slots (with 30-minute buffer)
 * - Past slots: Always disabled
 * - Related grounds: Check G1/G2 conflicts with Mega_Ground
 * 
 * @route GET /api/grounds/available-dates
 * @returns {Object} Dates grouped by month with availability
 * 
 * Response Format:
 * {
 *   "2025-01": [
 *     { "date": "2025-01-15", "enabled": true },
 *     { "date": "2025-01-16", "enabled": false }
 *   ],
 *   "2025-02": [...]
 * }
 */
export const getAvailableDates = async (req, res) => {
  try {
    // ========================================================================
    // DATE RANGE SETUP
    // ========================================================================
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 45); // Next 45 days

    // ========================================================================
    // FETCH GROUNDS AND BOOKINGS
    // ========================================================================
    
    // Fetch all grounds except Mega_Ground
    const grounds = await db.Ground.findAll({
      where: {
        name: {
          [db.Sequelize.Op.ne]: 'Mega_Ground'
        }
      }
    });

    // Fetch all paid bookings for the next 45 days
    const bookings = await db.Booking.findAll({
      where: {
        startTime: {
          [db.Sequelize.Op.gte]: today,
          [db.Sequelize.Op.lt]: endDate
        },
        paymentStatus: 'paid' // Only consider paid bookings
      },
      include: [{ model: db.Ground, as: 'ground' }]
    });

    // Fetch all blocked slots for the next 45 days
    const blockedSlots = await BlockedSlot.findAll({
      where: {
        date: {
          [db.Sequelize.Op.between]: [
            today.toISOString().split('T')[0],
            endDate.toISOString().split('T')[0]
          ]
        },
        isActive: true
      }
    });

    // ========================================================================
    // GROUP BOOKINGS AND BLOCKS BY DATE
    // ========================================================================
    
    const bookingsByDate = {};
    const blocksByDate = {};
    
    bookings.forEach(b => {
      const dateKey = b.startTime.toISOString().split('T')[0];
      if (!bookingsByDate[dateKey]) bookingsByDate[dateKey] = [];
      bookingsByDate[dateKey].push(b);
    });

    blockedSlots.forEach(b => {
      if (!blocksByDate[b.date]) blocksByDate[b.date] = [];
      blocksByDate[b.date].push(b);
    });

    // ========================================================================
    // PROCESS EACH DATE
    // ========================================================================
    
    const result = {};
    const currentDate = new Date(today);

    while (currentDate < endDate) {
      const dateStr = currentDate.toLocaleDateString('en-CA');
      const monthKey = dateStr.substring(0, 7); // YYYY-MM for grouping

      if (!result[monthKey]) result[monthKey] = [];

      const dayBookings = bookingsByDate[dateStr] || [];
      const dayBlocks = blocksByDate[dateStr] || [];
      const isToday = currentDate.toDateString() === now.toDateString();
      
      // ======================================================================
      // DETERMINE CHECKABLE HOURS
      // ======================================================================
      
      let requiredHours;
      if (isToday) {
        // For today, only check future hours with 30-minute buffer
        const currentHour = now.getHours();
        requiredHours = Array.from({ length: 24 - currentHour }, (_, i) => currentHour + i)
          .filter(h => {
            const requestedStartTime = new Date(currentDate);
            requestedStartTime.setHours(h, 0, 0, 0);
            const slotEndBuffer = new Date(requestedStartTime);
            slotEndBuffer.setMinutes(slotEndBuffer.getMinutes() + 30);
            return now < slotEndBuffer;
          });
      } else {
        // For future dates, check all 24 hours
        requiredHours = Array.from({ length: 24 }, (_, i) => i);
      }

      // ======================================================================
      // CHECK IF DATE HAS ANY AVAILABLE SLOT
      // ======================================================================
      
      let enabled = false;
      
      for (const hour of requiredHours) {
        const requestedStartTime = new Date(currentDate);
        requestedStartTime.setHours(hour, 0, 0, 0);
        const requestedEndTime = new Date(requestedStartTime);
        requestedEndTime.setHours(hour + 1);

        // Check if any ground is available for this hour
        let anyGroundAvailable = false;
        const slotLabel = getSlotLabel(hour);
        
        for (const ground of grounds) {
          const relatedGrounds = getRelatedGrounds(ground.name);
          const allRelevantGrounds = [ground.name, ...relatedGrounds];
          
          // Filter bookings for this ground and related grounds
          const relevantBookings = dayBookings.filter(b => 
            allRelevantGrounds.includes(b.ground.name)
          );
          
          // Check if slot is blocked for this ground
          if (isSlotBlocked(dayBlocks, slotLabel, ground.id)) {
            continue; // Skip this ground, it's blocked
          }
          
          // Check if ground is available (no overlapping bookings)
          let isAvailable = true;
          for (const booking of relevantBookings) {
            if (checkTimeOverlap(booking, requestedStartTime, requestedEndTime)) {
              isAvailable = false;
              break;
            }
          }
          
          if (isAvailable) {
            anyGroundAvailable = true;
            break;
          }
        }
        
        if (anyGroundAvailable) {
          enabled = true;
          break; // At least one slot is available, date is enabled
        }
      }

      result[monthKey].push({ date: dateStr, enabled });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching available dates:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Get available time slots for a specific date
 * 
 * Returns all 24 hours with enabled/disabled flag.
 * A slot is enabled if at least one ground is available.
 * 
 * Algorithm:
 * 1. Fetch all grounds and bookings for the date
 * 2. For each hour (0-23):
 *    a. Check if time has passed (30-minute buffer)
 *    b. For each ground, check related grounds
 *    c. Check if any booking overlaps
 *    d. If at least one ground available → enabled
 * 
 * @route GET /api/grounds/available-slots?date=YYYY-MM-DD
 * @query {string} date - Date in YYYY-MM-DD format
 * @returns {Array} Array of 24 slots with availability
 * 
 * Response Format:
 * [
 *   { "slot": "12:00 AM to 1:00 AM", "enabled": true },
 *   { "slot": "1:00 AM to 2:00 AM", "enabled": false },
 *   ...
 * ]
 */
export const getAvailableSlots = async (req, res) => {
  try {
    const { date } = req.query;
    
    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    
    if (!date) {
      return res.status(400).json({ error: 'date is required query parameter' });
    }

    // Parse date in IST (UTC+5:30) to ensure consistency
    const [year, month, day] = date.split('-').map(Number);
    if (!year || !month || !day) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Create date at midnight IST
    const dateObj = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    dateObj.setMinutes(dateObj.getMinutes() - 330); // Subtract IST offset
    
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({ error: 'Invalid date' });
    }

    const nextDay = new Date(dateObj);
    nextDay.setDate(nextDay.getDate() + 1);

    // ========================================================================
    // FETCH GROUNDS AND BOOKINGS
    // ========================================================================
    
    // Fetch grounds except Mega_Ground
    const grounds = await db.Ground.findAll({
      where: {
        name: {
          [db.Sequelize.Op.ne]: 'Mega_Ground'
        }
      }
    });

    // Fetch all paid bookings for the date
    const bookings = await db.Booking.findAll({
      where: {
        startTime: {
          [db.Sequelize.Op.gte]: dateObj,
          [db.Sequelize.Op.lt]: nextDay
        },
        paymentStatus: 'paid'
      },
      include: [{ model: db.Ground, as: 'ground' }]
    });

    // Fetch admin-blocked slots for this date (end users cannot book these)
    const dateStr = date;
    const blockedSlots = await BlockedSlot.findAll({
      where: { date: dateStr, isActive: true }
    });

    // ========================================================================
    // TIME CHECKING SETUP
    // ========================================================================
    
    const now = new Date();
    const isToday = dateObj.toDateString() === now.toDateString();

    // ========================================================================
    // PROCESS EACH HOUR
    // ========================================================================
    
    const result = [];
    
    for (let hour = 0; hour < 24; hour++) {
      const requestedStartTime = new Date(dateObj);
      requestedStartTime.setHours(requestedStartTime.getHours() + hour);
      const requestedEndTime = new Date(requestedStartTime);
      requestedEndTime.setHours(requestedEndTime.getHours() + 1);
      const slotEndBuffer = new Date(requestedStartTime);
      slotEndBuffer.setMinutes(slotEndBuffer.getMinutes() + 30);
      const slotLabel = getSlotLabel(hour);

      // Check if slot is during closed hours (1 AM - 6 AM)
      let enabled = true;
      if (isClosedHour(hour)) {
        enabled = false;
      } else if (now >= slotEndBuffer) {
        enabled = false;
      } else {
        // Check if at least one ground is available (not booked and not blocked)
        let anyGroundAvailable = false;
        
        for (const ground of grounds) {
          if (isSlotBlocked(blockedSlots, slotLabel, ground.id)) {
            continue;
          }
          const relatedGrounds = getRelatedGrounds(ground.name);
          const allRelevantGrounds = [ground.name, ...relatedGrounds];
          
          const relevantBookings = bookings.filter(b => 
            allRelevantGrounds.includes(b.ground.name)
          );
          
          let isAvailable = true;
          for (const booking of relevantBookings) {
            if (checkTimeOverlap(booking, requestedStartTime, requestedEndTime)) {
              isAvailable = false;
              break;
            }
          }
          
          if (isAvailable) {
            anyGroundAvailable = true;
            break;
          }
        }
        
        enabled = anyGroundAvailable;
      }
      
      result.push({ slot: slotLabel, enabled });
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Get available grounds for a specific date and time slot
 * 
 * Returns all grounds with availability flag for the requested slot.
 * 
 * Algorithm:
 * 1. Validate input parameters
 * 2. Fetch all grounds
 * 3. Fetch bookings for the entire date
 * 4. For each ground:
 *    a. Get related grounds (Mega_Ground ↔ G1/G2)
 *    b. Check if any related booking overlaps
 *    c. Mark as available or unavailable
 * 
 * @route GET /api/grounds/available-grounds?date=YYYY-MM-DD&startHour=0-23
 * @query {string} date - Date in YYYY-MM-DD format
 * @query {number} startHour - Start hour (0-23)
 * @returns {Array} Array of grounds with availability
 * 
 * Response Format:
 * [
 *   { "id": 1, "name": "G1", "location": "Area A", "available": true },
 *   { "id": 2, "name": "G2", "location": "Area B", "available": false },
 *   { "id": 3, "name": "Mega_Ground", "location": "Combined", "available": false }
 * ]
 */
export const getAvailableGrounds = async (req, res) => {
  try {
    const { date, startHour, startHours } = req.query;

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    
    if (!date) {
      return res.status(400).json({ error: 'date is required query parameter' });
    }
    if (!startHour && !startHours) {
      return res.status(400).json({ error: 'startHour or startHours is required query parameter' });
    }

    // Support both single hour and multiple hours
    let hoursArray;
    if (startHours) {
      // Parse comma-separated hours
      hoursArray = startHours.split(',').map(h => parseInt(h.trim()));
    } else {
      hoursArray = [parseInt(startHour)];
    }

    // Validate all hours
    for (const hour of hoursArray) {
      if (isNaN(hour) || hour < 0 || hour > 23) {
        return res.status(400).json({ error: 'All hours must be between 0 and 23' });
      }
    }

    // Parse date (YYYY-MM-DD) and build IST day bounds
    const dayStart = getIstDayStart(date);
    if (!dayStart || isNaN(dayStart.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    // ========================================================================
    // FETCH GROUNDS AND BOOKINGS
    // ========================================================================
    
    // Fetch all grounds except Mega_Ground
    const grounds = await db.Ground.findAll({
      where: {
        name: {
          [db.Sequelize.Op.ne]: 'Mega_Ground'
        }
      }
    });

    // Fetch all paid bookings for the IST date range
    const bookings = await db.Booking.findAll({
      where: {
        startTime: {
          [db.Sequelize.Op.gte]: dayStart,
          [db.Sequelize.Op.lt]: dayEnd
        },
        paymentStatus: 'paid'
      },
      include: [{ model: db.Ground, as: 'ground' }]
    });

    // Fetch admin-blocked slots for this date (end users cannot book these)
    const blockedSlots = await BlockedSlot.findAll({
      where: { date: date, isActive: true }
    });

    // ========================================================================
    // CHECK AVAILABILITY FOR EACH GROUND
    // ========================================================================
    
    const availableGrounds = grounds.map(ground => {
      const relatedGrounds = getRelatedGrounds(ground.name);
      const allRelevantGrounds = [ground.name, ...relatedGrounds];
      
      // Filter bookings for this ground and related grounds
      const relevantBookings = bookings.filter(b => 
        allRelevantGrounds.includes(b.ground.name)
      );
      
      // Check if ground is available for ALL requested hours (not booked and not blocked)
      let isAvailable = true;
      for (const hour of hoursArray) {
        if (isSlotBlocked(blockedSlots, getSlotLabel(hour), ground.id)) {
          isAvailable = false;
          break;
        }
        const slotBounds = buildIstSlotBounds(date, hour);
        if (!slotBounds) {
          isAvailable = false;
          break;
        }
        const { requestedStartTime, requestedEndTime } = slotBounds;

        // Check if this specific hour has any conflicts
        for (const booking of relevantBookings) {
          if (checkTimeOverlap(booking, requestedStartTime, requestedEndTime)) {
            isAvailable = false;
            break;
          }
        }
        
        if (!isAvailable) break; // If any hour is unavailable, ground is unavailable
      }

      // Calculate total pricing for all requested hours (dateObj for weekday/weekend)
      const dateObj = new Date(dayStart.getTime() + IST_OFFSET_MS);
      let totalPrice = 0;
      for (const hour of hoursArray) {
        totalPrice += calculatePrice(ground, dateObj, hour);
      }

      // Calculate average price per hour for display
      const pricePerHour = hoursArray.length > 0 ? Math.round(totalPrice / hoursArray.length) : totalPrice;

      return {
        id: ground.id,
        name: ground.name,
        description: ground.description,
        available: isAvailable,
        disabled: !isAvailable, // Explicit: ground is disabled when already booked or blocked
        price: totalPrice, // Total price for all hours
        pricePerHour: pricePerHour, // Average price per hour
        pricing: ground.pricing // Include full pricing object for admin panel
      };
    });

    res.json(availableGrounds);
  } catch (error) {
    console.error('Error fetching available grounds:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ============================================================================
// SMART SPLIT BOOKING - N-SLOT ALLOCATION ALGORITHM
// ============================================================================

/**
 * Get smart booking options for a given date, start hour, and duration.
 *
 * Returns an array of booking options including:
 * - Single-ground options (0 switches) for each fully-available ground
 * - Split/switch-ground options (1-2 switches) across G1/G2
 *
 * The algorithm builds an availability matrix and uses recursive backtracking
 * to find all valid N-hour paths across grounds.
 *
 * @route GET /api/grounds/get-smart-options?date=YYYY-MM-DD&startHour=N&duration=N
 * @query {string} date - Date in YYYY-MM-DD format
 * @query {number} startHour - Starting hour (0-23)
 * @query {number} duration - Number of consecutive hours (1-12)
 * @returns {Array} Sorted array of booking options
 */
export const getSmartBookingOptions = async (req, res) => {
  try {
    const { date, startHour, duration } = req.query;

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================

    if (!date || startHour === undefined || !duration) {
      return res.status(400).json({
        error: 'date, startHour, and duration are required query parameters'
      });
    }

    const parsedStartHour = parseInt(startHour);
    const parsedDuration = parseInt(duration);

    if (isNaN(parsedStartHour) || parsedStartHour < 0 || parsedStartHour > 23) {
      return res.status(400).json({ error: 'startHour must be between 0 and 23' });
    }
    if (isNaN(parsedDuration) || parsedDuration < 1 || parsedDuration > 12) {
      return res.status(400).json({ error: 'duration must be between 1 and 12' });
    }

    // Generate the array of required hours
    const requiredHours = [];
    for (let i = 0; i < parsedDuration; i++) {
      const hour = parsedStartHour + i;
      if (hour > 23) {
        return res.status(400).json({
          error: 'Requested time range extends past midnight. Please select a shorter duration.'
        });
      }
      if (isClosedHour(hour)) {
        return res.status(400).json({
          error: `Hour ${hour}:00 falls within closed hours (1 AM - 6 AM).`
        });
      }
      requiredHours.push(hour);
    }

    // Parse date and build IST day bounds
    const dayStart = getIstDayStart(date);
    if (!dayStart || isNaN(dayStart.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    // Check if any requested slot is in the past
    const now = new Date();
    const firstSlotBounds = buildIstSlotBounds(date, requiredHours[0]);
    if (firstSlotBounds) {
      const slotEndBuffer = new Date(firstSlotBounds.requestedStartTime);
      slotEndBuffer.setMinutes(slotEndBuffer.getMinutes() + 30);
      if (now >= slotEndBuffer) {
        return res.status(400).json({
          error: 'The requested start time has already passed.'
        });
      }
    }

    // ========================================================================
    // FETCH GROUNDS, BOOKINGS, AND BLOCKED SLOTS
    // ========================================================================

    // Exclude Mega_Ground per user request to disable double ground facility
    const grounds = await db.Ground.findAll({
      where: {
        name: {
          [db.Sequelize.Op.ne]: 'Mega_Ground'
        }
      }
    });
    const bookings = await db.Booking.findAll({
      where: {
        startTime: {
          [db.Sequelize.Op.gte]: dayStart,
          [db.Sequelize.Op.lt]: dayEnd
        },
        paymentStatus: {
          [db.Sequelize.Op.in]: ['paid', 'processing']
        }
      },
      include: [{ model: db.Ground, as: 'ground' }]
    });

    const blockedSlots = await BlockedSlot.findAll({
      where: { date: date, isActive: true }
    });

    // ========================================================================
    // BUILD AVAILABILITY MATRIX
    // ========================================================================

    // matrix[groundName][hour] = true (available) | false (booked/blocked)
    const matrix = {};
    const groundMap = {}; // groundName -> ground model object

    for (const ground of grounds) {
      groundMap[ground.name] = ground;
      matrix[ground.name] = {};

      for (const hour of requiredHours) {
        const slotLabel = getSlotLabel(hour);

        // Check if blocked
        if (isSlotBlocked(blockedSlots, slotLabel, ground.id)) {
          matrix[ground.name][hour] = false;
          continue;
        }

        // Check if booked (including related grounds)
        const relatedGrounds = getRelatedGrounds(ground.name);
        const allRelevantGrounds = [ground.name, ...relatedGrounds];
        const relevantBookings = bookings.filter(b =>
          allRelevantGrounds.includes(b.ground.name)
        );

        const slotBounds = buildIstSlotBounds(date, hour);
        if (!slotBounds) {
          matrix[ground.name][hour] = false;
          continue;
        }

        let isAvailable = true;
        for (const booking of relevantBookings) {
          if (checkTimeOverlap(booking, slotBounds.requestedStartTime, slotBounds.requestedEndTime)) {
            isAvailable = false;
            break;
          }
        }

        matrix[ground.name][hour] = isAvailable;
      }
    }

    // ========================================================================
    // PRICING HELPER
    // ========================================================================

    const dateObj = new Date(dayStart.getTime() + IST_OFFSET_MS);

    function getPriceForSlot(groundName, hour) {
      const ground = groundMap[groundName];
      if (!ground) return 0;
      return calculatePrice(ground, dateObj, hour);
    }

    // ========================================================================
    // 1. SINGLE-GROUND OPTIONS (0 switches)
    // ========================================================================

    const options = [];

    for (const ground of grounds) {
      let allAvailable = true;
      let totalPrice = 0;
      const slots = [];

      for (const hour of requiredHours) {
        if (!matrix[ground.name][hour]) {
          allAvailable = false;
          break;
        }
        const price = getPriceForSlot(ground.name, hour);
        totalPrice += price;
        slots.push({
          hour,
          groundId: ground.id,
          groundName: ground.name,
          price
        });
      }

      options.push({
        type: 'single',
        label: ground.name === 'Mega_Ground' ? 'Double Ground' : (ground.name === 'G1' ? 'Ground 1' : 'Ground 2'),
        groundName: ground.name,
        groundId: ground.id,
        description: ground.description,
        switches: 0,
        slots,
        totalPrice,
        pricePerHour: Math.round(totalPrice / parsedDuration),
        available: allAvailable,
        disabled: !allAvailable
      });
    }

    // ========================================================================
    // 2. SPLIT-GROUND OPTIONS (1-2 switches) - Only G1/G2
    // ========================================================================

    const splitGrounds = ['G1', 'G2'];
    const splitPaths = [];

    // Only compute splits if no single-ground option is fully available
    // and this is a multi-hour booking
    if (!options.some(opt => opt.available) && parsedDuration > 1) {
      function findSplitPaths(slotIndex, currentPath, switchCount) {
        if (slotIndex === requiredHours.length) {
          // Only add if there's at least one switch
          if (switchCount > 0) {
            splitPaths.push({
              path: [...currentPath],
              switches: switchCount
            });
          }
          return;
        }

        const hour = requiredHours[slotIndex];

        for (const groundName of splitGrounds) {
          if (!matrix[groundName] || !matrix[groundName][hour]) continue;

          const lastGround = currentPath.length > 0
            ? currentPath[currentPath.length - 1].groundName
            : null;

          let newSwitchCount = switchCount;
          if (lastGround && lastGround !== groundName) {
            newSwitchCount++;
          }

          const price = getPriceForSlot(groundName, hour);
          currentPath.push({
            hour,
            groundId: groundMap[groundName].id,
            groundName,
            price
          });

          findSplitPaths(slotIndex + 1, currentPath, newSwitchCount);
          currentPath.pop();
        }
      }

      findSplitPaths(0, [], 0);

      // Deduplicate split paths
      const seenSequences = new Set();
      const splitOptionsCandidate = [];

      for (const { path, switches } of splitPaths) {
        const sequence = path.map(s => s.groundName).join(',');
        if (seenSequences.has(sequence)) continue;
        seenSequences.add(sequence);

        const totalPrice = path.reduce((sum, s) => sum + s.price, 0);

        const segments = [];
        let currentSegment = { groundName: path[0].groundName, hours: [path[0].hour] };
        for (let i = 1; i < path.length; i++) {
          if (path[i].groundName === currentSegment.groundName) {
            currentSegment.hours.push(path[i].hour);
          } else {
            segments.push(currentSegment);
            currentSegment = { groundName: path[i].groundName, hours: [path[i].hour] };
          }
        }
        segments.push(currentSegment);

        const labelParts = segments.map(seg => {
          const displayName = seg.groundName === 'G1' ? 'Ground 1' : 'Ground 2';
          const startLabel = getSlotLabel(seg.hours[0]).split(' to ')[0];
          const endLabel = getSlotLabel(seg.hours[seg.hours.length - 1]).split(' to ')[1];
          return `${displayName} (${startLabel} - ${endLabel})`;
        });

        splitOptionsCandidate.push({
          type: 'split',
          label: 'Switch Grounds',
          description: labelParts.join(' → '),
          switches,
          segments,
          slots: path.map(s => ({ ...s })),
          totalPrice,
          pricePerHour: Math.round(totalPrice / parsedDuration)
        });
      }

      // We only want to generate a single split card that has the minimum number of switches
      if (splitOptionsCandidate.length > 0) {
        // Find the absolute minimum switches across all valid paths
        const minSwitches = Math.min(...splitOptionsCandidate.map(o => o.switches));
        
        // Filter out all paths that have more switches than the minimum
        const bestOptions = splitOptionsCandidate.filter(o => o.switches === minSwitches);
        
        // Pick the best one (we sort by price just as a tie-breaker, then take [0])
        bestOptions.sort((a, b) => a.totalPrice - b.totalPrice);
        
        options.push(bestOptions[0]);
      }
    }

    // ========================================================================
    // 3. SORT - single options
    // ========================================================================

    options.sort((a, b) => {
      // If we have a single option vs a split option, single comes first conceptually
      // but here options array either contains multiple single options OR one split option.
      return a.totalPrice - b.totalPrice;
    });

    res.json({
      date,
      startHour: parsedStartHour,
      duration: parsedDuration,
      requiredHours,
      options
    });
  } catch (error) {
    console.error('Error computing smart booking options:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
