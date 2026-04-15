import db from './models/index.js';

async function run() {
  const date = new Date('2026-04-12T00:00:00Z');
  
  const createBooking = async (groundId, startHour, endHour) => {
    await db.Booking.create({
      groundId,
      startTime: new Date(`2026-04-12T${startHour.toString().padStart(2, '0')}:30:00.000Z`), // Using IST approximation
      endTime: new Date(`2026-04-12T${endHour.toString().padStart(2, '0')}:30:00.000Z`),
      paymentStatus: 'paid',
      splitType: 'single'
    });
  };

  // User availability map:
  // 6-7: G2 -> means G1 is booked
  // 7-8: G2 -> means G1 is booked
  // 8-9: G1 -> means G2 is booked
  // 9-10: G2 -> means G1 is booked
  // 10-11: G1 -> means G2 is booked
  // 11-12: G1 & G2 -> neither booked
  
  await createBooking(1, 0, 2); // Book G1 for hours 0 and 1 UTC (approx 5:30 to 7:30 IST) - wait, exact hours matching 6am-8am IST:
  // 6:00 AM IST = 00:30 UTC
  // 8:00 AM IST = 02:30 UTC
  await db.Booking.create({ groundId: 1, startTime: new Date('2026-04-12T00:30:00Z'), endTime: new Date('2026-04-12T02:30:00Z'), paymentStatus: 'paid' });
  
  // 8-9 AM IST: G1 available, G2 booked. 8 AM IST = 02:30 UTC
  await db.Booking.create({ groundId: 2, startTime: new Date('2026-04-12T02:30:00Z'), endTime: new Date('2026-04-12T03:30:00Z'), paymentStatus: 'paid' });
  
  // 9-10 AM IST: G2 available, G1 booked. 9 AM IST = 03:30 UTC
  await db.Booking.create({ groundId: 1, startTime: new Date('2026-04-12T03:30:00Z'), endTime: new Date('2026-04-12T04:30:00Z'), paymentStatus: 'paid' });
  
  // 10-11 AM IST: G1 available, G2 booked. 10 AM IST = 04:30 UTC
  await db.Booking.create({ groundId: 2, startTime: new Date('2026-04-12T04:30:00Z'), endTime: new Date('2026-04-12T05:30:00Z'), paymentStatus: 'paid' });

  console.log('Bookings created');
  process.exit(0);
}

run();
