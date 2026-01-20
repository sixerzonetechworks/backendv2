/**
 * ============================================================================
 * PAYMENT CONTROLLER
 * ============================================================================
 * 
 * Handles all payment-related operations for turf bookings using Razorpay.
 * 
 * Payment Flow:
 * 1. User selects slot → createOrder() creates booking + Razorpay order
 * 2. Frontend opens Razorpay modal with order ID
 * 3. User completes payment → Razorpay sends payment details
 * 4. Frontend calls verifyPayment() with signature
 * 5. Backend verifies HMAC SHA256 signature
 * 6. If valid → booking marked as 'paid'
 * 7. If invalid or failed → booking marked as 'failed'
 * 
 * Security:
 * - HMAC SHA256 signature verification prevents tampering
 * - Payment status fetched from Razorpay API for double verification
 * - Only 'paid' bookings block slots
 * 
 * ============================================================================
 */

import Razorpay from 'razorpay';
import crypto from 'crypto';
import db from '../models/index.js';

// ============================================================================
// RAZORPAY INITIALIZATION
// ============================================================================

/**
 * Initialize Razorpay instance with credentials from environment variables
 * 
 * Required env vars:
 * - RAZORPAY_KEY_ID: Your Razorpay key ID (starts with rzp_test_ or rzp_live_)
 * - RAZORPAY_KEY_SECRET: Your Razorpay key secret
 */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get related grounds for conflict detection
 * 
 * Rules:
 * - Mega_Ground blocks both G1 and G2
 * - G1 or G2 blocks Mega_Ground
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
 * Calculate pricing for a single hour
 * 
 * Pricing Structure:
 * - Weekday (Mon-Fri): Different rates for first/second half
 * - Weekend (Sat-Sun): Different rates for first/second half
 * - First half: 6:00 AM to 6:00 PM (hours 6-17)
 * - Second half: 6:00 PM to 6:00 AM (hours 18-23 and 0-5)
 * - Closed hours (1 AM - 6 AM) should not be priced
 * 
 * @param {Object} ground - Ground model with pricing JSON
 * @param {Date} date - Booking date
 * @param {number} hour - Hour of booking (0-23)
 * @returns {number} Price for this hour in INR
 */
function calculateHourPricing(ground, date, hour) {
  const dayOfWeek = date.getDay();
  
  // Determine if weekend (0 = Sunday, 6 = Saturday)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  
  // Determine if first half or second half
  // First half: 6 AM to 6 PM (hours 6-17)
  // Second half: 6 PM to 6 AM (hours 18-23 and 0-5)
  const isFirstHalf = hour >= 6 && hour < 18;
  
  // Select pricing key from ground's pricing JSON
  let pricingKey;
  if (isWeekend) {
    pricingKey = isFirstHalf ? 'Weekend_first_half' : 'Weekend_second_half';
  } else {
    pricingKey = isFirstHalf ? 'Weekday_first_half' : 'Weekday_second_half';
  }
  
  // Return price for 1 hour (prices in DB are per hour)
  return ground.pricing[pricingKey] || 1000; // Default to 1000 if key not found
}

/**
 * Calculate total pricing for multiple consecutive hours
 * Each hour is priced individually based on its time-of-day rate
 * 
 * @param {Object} ground - Ground model with pricing JSON
 * @param {Date} date - Booking date
 * @param {number[]} startHours - Array of start hours to book
 * @returns {number} Total amount in INR
 */
function calculatePricing(ground, date, startHours) {
  // If startHours is a single number (legacy support), convert to array
  const hoursArray = Array.isArray(startHours) ? startHours : [startHours];
  
  // Calculate price for each hour individually and sum up
  // Important: Each hour may have different pricing based on weekday/weekend and time of day
  let totalAmount = 0;
  for (const hour of hoursArray) {
    const hourPrice = calculateHourPricing(ground, date, hour);
    totalAmount += hourPrice;
  }
  
  return totalAmount;
}

/**
 * Check if multiple slots conflict with existing bookings
 * 
 * Conflict Checking:
 * - Checks ground and related grounds (Mega_Ground ↔ G1/G2)
 * - Only considers 'paid' and 'processing' bookings
 * - Checks if any requested hour overlaps with any booked hour
 * - Handles multi-hour bookings from legacy data
 * 
 * @param {number[]} startHours - Array of requested start hours (0-23)
 * @param {Date} dateObj - Requested date (start of day)
 * @param {number[]} relevantGroundIds - IDs of ground and related grounds
 * @returns {Promise<boolean>} True if any slot is already booked
 */
async function checkSlotConflict(startHours, dateObj, relevantGroundIds) {
  // Convert single number to array for backward compatibility
  const hoursArray = Array.isArray(startHours) ? startHours : [startHours];
  
  // Fetch overlapping bookings for the entire day
  const overlappingBookings = await db.Booking.findAll({
    where: {
      groundId: {
        [db.Sequelize.Op.in]: relevantGroundIds
      },
      startTime: {
        [db.Sequelize.Op.gte]: dateObj,
        [db.Sequelize.Op.lt]: new Date(dateObj.getTime() + 24 * 60 * 60 * 1000)
      },
      paymentStatus: {
        [db.Sequelize.Op.in]: ['paid', 'processing']
      }
    }
  });

  // Check if any requested hour conflicts with any booking
  for (const requestedHour of hoursArray) {
    const hasConflict = overlappingBookings.some(booking => {
      const bookingStartHour = booking.startTime.getHours();
      
      // Check single-hour booking (standard case)
      if (booking.duration === 1 && bookingStartHour === requestedHour) {
        return true;
      }
      
      // Check multi-hour bookings
      for (let i = 0; i < booking.duration; i++) {
        if ((bookingStartHour + i) % 24 === requestedHour) {
          return true;
        }
      }
      
      return false;
    });
    
    if (hasConflict) {
      return true;
    }
  }
  
  return false;
}

// ============================================================================
// CONTROLLER FUNCTIONS
// ============================================================================

/**
 * Create a Razorpay order for a new booking
 * 
 * Steps:
 * 1. Validate input parameters
 * 2. Check ground exists
 * 3. Validate date and time
 * 4. Check for slot conflicts
 * 5. Calculate pricing
 * 6. Create booking with 'pending' status
 * 7. Create Razorpay order
 * 8. Update booking to 'processing' status
 * 9. Return order details for frontend
 * 
 * @route POST /api/payments/create-order
 * @body {string} name - Customer name
 * @body {string} phone - Customer phone (10-15 digits)
 * @body {string} email - Customer email
 * @body {number} groundId - Ground ID
 * @body {string} date - Date in YYYY-MM-DD format
 * @body {number} startHour - Start hour (0-23)
 * @returns {Object} Booking and Razorpay order details
 */
export const createOrder = async (req, res) => {
  try {
    const { name, phone, email, groundId, date, startHour, startHours } = req.body;

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    
    if (!name || !phone || !email || !groundId || !date || (startHour === undefined && !startHours)) {
      return res.status(400).json({ 
        success: false,
        error: 'All fields are required',
        details: 'Please provide name, phone, email, ground, date, and time slots'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid email format',
        details: 'Please provide a valid email address'
      });
    }

    // Validate phone format (10-15 digits)
    const phoneStr = phone.toString().replace(/\D/g, '');
    if (phoneStr.length < 10 || phoneStr.length > 15) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid phone number',
        details: 'Phone number must be between 10-15 digits'
      });
    }

    // Support both single hour (startHour) and multiple hours (startHours)
    let hoursArray;
    if (startHours) {
      // Handle if startHours is sent as string (JSON parse issue)
      if (typeof startHours === 'string') {
        try {
          hoursArray = JSON.parse(startHours).map(h => parseInt(h));
        } catch {
          hoursArray = [parseInt(startHours)];
        }
      } else if (Array.isArray(startHours)) {
        hoursArray = startHours.map(h => parseInt(h));
      } else {
        hoursArray = [parseInt(startHours)];
      }
    } else if (startHour !== undefined) {
      hoursArray = [parseInt(startHour)];
    } else {
      return res.status(400).json({ 
        success: false,
        error: 'Time slots required',
        details: 'startHour or startHours is required' 
      });
    }

    // Log booking request
    console.log(`📅 Booking request: ${name} | Ground ${groundId} | ${hoursArray.length}h | ${date} | Hours: [${hoursArray.join(', ')}]`);

    // Validate all hours
    for (const hour of hoursArray) {
      if (isNaN(hour) || hour < 0 || hour > 23) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid time slot',
          details: 'All hours must be between 0 and 23'
        });
      }
    }

    // Check for closed hours (1 AM - 6 AM)
    const closedHours = hoursArray.filter(h => h >= 1 && h < 6);
    if (closedHours.length > 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Turf is closed during selected hours',
        details: 'Turf is closed from 1:00 AM to 6:00 AM. Please select different time slots.'
      });
    }

    // Validate that hours are consecutive if multiple hours
    if (hoursArray.length > 1) {
      const sortedHours = [...hoursArray].sort((a, b) => a - b);
      for (let i = 1; i < sortedHours.length; i++) {
        if (sortedHours[i] !== sortedHours[i - 1] + 1) {
          return res.status(400).json({ 
            success: false,
            error: 'Non-consecutive time slots selected',
            details: 'Please select consecutive time slots for multiple hour booking'
          });
        }
      }
    }

    // ========================================================================
    // GROUND VALIDATION
    // ========================================================================
    
    const ground = await db.Ground.findByPk(groundId);
    if (!ground) {
      return res.status(404).json({ 
        success: false,
        error: 'Ground not found',
        details: 'The selected ground is not available. Please try again.'
      });
    }

    // ========================================================================
    // DATE & TIME VALIDATION
    // ========================================================================
    
    // Parse date (assumes YYYY-MM-DD format)
    const dateObj = new Date(date + 'T00:00:00');
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid date format',
        details: 'Please provide date in YYYY-MM-DD format'
      });
    }

    // Create start and end times based on first and last hour
    const sortedHours = [...hoursArray].sort((a, b) => a - b);
    const firstHour = sortedHours[0];
    const lastHour = sortedHours[sortedHours.length - 1];
    const duration = hoursArray.length;

    const startTime = new Date(dateObj);
    startTime.setHours(firstHour, 0, 0, 0);

    const endTime = new Date(dateObj);
    endTime.setHours(lastHour + 1, 0, 0, 0);

    // Prevent booking past slots (allow up to 30 minutes into the first slot)
    const now = new Date();
    const slotEndBuffer = new Date(startTime);
    slotEndBuffer.setMinutes(slotEndBuffer.getMinutes() + 30);
    
    if (now >= slotEndBuffer) {
      return res.status(400).json({ 
        success: false,
        error: 'Cannot book past time slots',
        details: 'The selected time slot has already passed or has less than 30 minutes remaining. Please select a future slot.'
      });
    }

    // ========================================================================
    // CONFLICT DETECTION
    // ========================================================================
    
    // Get related grounds (Mega_Ground ↔ G1/G2)
    const relatedGrounds = getRelatedGrounds(ground.name);
    const allRelevantGroundNames = [ground.name, ...relatedGrounds];

    // Fetch ground IDs for conflict checking
    const relevantGrounds = await db.Ground.findAll({
      where: {
        name: {
          [db.Sequelize.Op.in]: allRelevantGroundNames
        }
      }
    });
    const relevantGroundIds = relevantGrounds.map(g => g.id);

    // Check if any of the selected slots are already booked
    const isSlotBooked = await checkSlotConflict(hoursArray, dateObj, relevantGroundIds);
    
    if (isSlotBooked) {
      return res.status(400).json({ 
        success: false,
        error: 'Time slots not available',
        details: 'One or more selected time slots are already booked. Please choose different slots or a different ground.'
      });
    }

    // ========================================================================
    // PRICING CALCULATION
    // ========================================================================
    
    const totalAmount = calculatePricing(ground, dateObj, hoursArray);

    // ========================================================================
    // CREATE BOOKING (PENDING STATUS)
    // ========================================================================
    
    const booking = await db.Booking.create({
      name,
      phone,
      email,
      groundId,
      startTime,
      endTime,
      duration,
      totalAmount,
      paymentStatus: 'pending',
      paymentAttempts: 0
    });

    console.log(`✅ Booking created: ID ${booking.id} | ${ground.name} | ${duration}h | ₹${totalAmount} | ${startTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);    

    // ========================================================================
    // CREATE RAZORPAY ORDER
    // ========================================================================
    
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(totalAmount * 100), // Razorpay expects amount in paise
      currency: 'INR',
      receipt: `booking_${booking.id}`,
      notes: {
        bookingId: booking.id,
        groundName: ground.name,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        hours: hoursArray.join(','),
        duration: duration,
        customerEmail: email
      }
    });

    console.log(`💳 Razorpay order: ${razorpayOrder.id} | ₹${totalAmount}`);

    // ========================================================================
    // UPDATE BOOKING TO PROCESSING
    // ========================================================================
    
    await booking.update({
      razorpayOrderId: razorpayOrder.id,
      paymentStatus: 'processing'
    });

    // ========================================================================
    // RETURN RESPONSE
    // ========================================================================
    
    res.status(201).json({
      success: true,
      booking: {
        id: booking.id,
        name: booking.name,
        phone: booking.phone,
        email: booking.email,
        groundId: booking.groundId,
        groundName: ground.name,
        date: date,
        startHours: hoursArray,
        startHour: hoursArray[0], // For backward compatibility
        startTime: booking.startTime,
        endTime: booking.endTime,
        duration: booking.duration,
        totalAmount: parseFloat(booking.totalAmount), // Ensure it's a number
        paymentStatus: booking.paymentStatus
      },
      order: {
        id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID
    });

    console.log('Response sent with totalAmount:', booking.totalAmount);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

/**
 * Verify payment signature and update booking status
 * 
 * Security Flow:
 * 1. Receive payment details from frontend
 * 2. Generate expected signature using HMAC SHA256
 * 3. Compare with received signature
 * 4. Fetch payment details from Razorpay API
 * 5. Verify payment status is 'captured' or 'authorized'
 * 6. Update booking to 'paid' status
 * 
 * Signature Verification:
 * - Formula: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
 * - Prevents tampering with payment details
 * - Ensures payment came from Razorpay
 * 
 * @route POST /api/payments/verify
 * @body {string} razorpay_order_id - Razorpay order ID
 * @body {string} razorpay_payment_id - Razorpay payment ID
 * @body {string} razorpay_signature - Payment signature
 * @body {number} bookingId - Booking ID
 * @returns {Object} Payment verification result
 */
export const verifyPayment = async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature,
      bookingId 
    } = req.body;

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !bookingId) {
      return res.status(400).json({ error: 'Missing payment verification details' });
    }

    // ========================================================================
    // FETCH BOOKING
    // ========================================================================
    
    const booking = await db.Booking.findByPk(bookingId, {
      include: [{ model: db.Ground, as: 'ground' }]
    });

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // ========================================================================
    // SIGNATURE VERIFICATION
    // ========================================================================
    
    // Generate expected signature using HMAC SHA256
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isSignatureValid = expectedSignature === razorpay_signature;

    if (!isSignatureValid) {
      // Mark payment as failed due to invalid signature
      await booking.update({
        paymentAttempts: booking.paymentAttempts + 1,
        paymentStatus: 'failed',
        paymentFailureReason: 'Invalid payment signature'
      });

      return res.status(400).json({ 
        success: false, 
        error: 'Payment verification failed. Invalid signature.' 
      });
    }

    // ========================================================================
    // FETCH PAYMENT DETAILS FROM RAZORPAY
    // ========================================================================
    
    let paymentDetails;
    try {
      paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (err) {
      console.error('Error fetching payment details:', err);
      
      await booking.update({
        paymentAttempts: booking.paymentAttempts + 1,
        paymentStatus: 'failed',
        paymentFailureReason: 'Could not fetch payment details from Razorpay'
      });
      
      return res.status(500).json({ 
        success: false, 
        error: 'Could not verify payment with Razorpay' 
      });
    }

    // ========================================================================
    // VERIFY PAYMENT STATUS
    // ========================================================================
    
    // Check if payment was successful (captured or authorized)
    if (paymentDetails.status !== 'captured' && paymentDetails.status !== 'authorized') {
      await booking.update({
        paymentAttempts: booking.paymentAttempts + 1,
        paymentStatus: 'failed',
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        paymentFailureReason: `Payment status: ${paymentDetails.status}`
      });

      return res.status(400).json({ 
        success: false, 
        error: `Payment not successful. Status: ${paymentDetails.status}` 
      });
    }

    // ========================================================================
    // UPDATE BOOKING TO PAID
    // ========================================================================
    
    await booking.update({
      paymentStatus: 'paid',
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      paymentMethod: paymentDetails.method,
      paymentCompletedAt: new Date(),
      paymentAttempts: booking.paymentAttempts + 1
    });

    console.log(`✅ Payment verified: Booking ${booking.id} | ${razorpay_payment_id} | ₹${booking.totalAmount}`);

    // ========================================================================
    // RETURN SUCCESS RESPONSE
    // ========================================================================
    
    res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      booking: {
        id: booking.id,
        name: booking.name,
        phone: booking.phone,
        email: booking.email,
        groundName: booking.ground.name,
        startTime: booking.startTime,
        endTime: booking.endTime,
        duration: booking.duration,
        totalAmount: booking.totalAmount,
        paymentStatus: booking.paymentStatus,
        paymentMethod: booking.paymentMethod,
        paymentCompletedAt: booking.paymentCompletedAt,
        razorpayPaymentId: booking.razorpayPaymentId,
        razorpayOrderId: booking.razorpayOrderId
      }
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

/**
 * Handle payment failure from frontend
 * 
 * Called when:
 * - User cancels payment modal
 * - Payment fails on Razorpay
 * - Network error during payment
 * 
 * Updates booking with failure information and increments attempt counter.
 * 
 * @route POST /api/payments/failure
 * @body {number} bookingId - Booking ID
 * @body {Object} error - Error details from Razorpay
 * @returns {Object} Failure acknowledgment
 */
export const handlePaymentFailure = async (req, res) => {
  try {
    const { bookingId, error } = req.body;

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    
    if (!bookingId) {
      return res.status(400).json({ error: 'Booking ID is required' });
    }

    // ========================================================================
    // FETCH BOOKING
    // ========================================================================
    
    const booking = await db.Booking.findByPk(bookingId);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // ========================================================================
    // UPDATE BOOKING WITH FAILURE INFO
    // ========================================================================
    
    await booking.update({
      paymentStatus: 'failed',
      paymentAttempts: booking.paymentAttempts + 1,
      paymentFailureReason: error?.description || error?.reason || 'Payment failed by user'
    });

    console.log(`❌ Payment failed: Booking ${booking.id} | Reason: ${error?.description || 'User cancelled'}`);

    // ========================================================================
    // RETURN RESPONSE
    // ========================================================================
    
    res.status(200).json({
      success: true,
      message: 'Payment failure recorded'
    });
  } catch (error) {
    console.error('Error handling payment failure:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

/**
 * Cancel a pending or failed booking
 * 
 * Cleanup function for:
 * - Abandoned bookings (user left before payment)
 * - Failed payments (user wants to try again)
 * 
 * Notes:
 * - Cannot cancel paid bookings (use refund process instead)
 * - Deletes booking record completely
 * - Frees up the slot for other users
 * 
 * @route DELETE /api/payments/cancel/:bookingId
 * @param {number} bookingId - Booking ID to cancel
 * @returns {Object} Cancellation confirmation
 */
export const cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;

    // ========================================================================
    // FETCH BOOKING
    // ========================================================================
    
    const booking = await db.Booking.findByPk(bookingId);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // ========================================================================
    // VALIDATE CANCELLATION
    // ========================================================================
    
    // Cannot cancel paid bookings (refund process needed)
    if (booking.paymentStatus === 'paid') {
      return res.status(400).json({ 
        error: 'Cannot cancel paid booking. Please request refund.' 
      });
    }

    // ========================================================================
    // DELETE BOOKING
    // ========================================================================
    
    await booking.destroy();

    // ========================================================================
    // RETURN RESPONSE
    // ========================================================================
    
    res.status(200).json({
      success: true,
      message: 'Booking cancelled successfully'
    });
  } catch (error) {
    console.error('Error cancelling booking:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};
