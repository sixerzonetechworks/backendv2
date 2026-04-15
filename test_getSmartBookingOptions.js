import { getSmartBookingOptions } from './controllers/groundController.js';
import db from './models/index.js';

// Setup mock req/res
const req = {
  query: {
    date: '2026-04-12',
    startHour: '6',
    duration: '6'
  }
};

const res = {
  json: function(data) {
    console.log("JSON RESPONSE:", JSON.stringify(data, null, 2).substring(0, 500) + "...[TRUNCATED]");
  },
  status: function(code) {
    console.log("STATUS CODE:", code);
    return this;
  }
};

// We will stub db.Ground.findAll, db.Booking.findAll, db.BlockedSlot.findAll
const origGroundFindAll = db.Ground.findAll;
const origBookingFindAll = db.Booking.findAll;
const origBlockedSlotFindAll = db.BlockedSlot.findAll;

db.Ground.findAll = async () => {
  return [
    { id: 1, name: 'G1', description: 'Ground 1', pricing: { basePrice: 600 } },
    { id: 2, name: 'G2', description: 'Ground 2', pricing: { basePrice: 600 } }
  ];
};

db.BlockedSlot.findAll = async () => [];

// User's setup:
// 6-7: G2 available, G1 booked
// 7-8: G2 available, G1 booked
// 8-9: G1 available, G2 booked
// 9-10: G2 available, G1 booked
// 10-11: G1 available, G2 booked
// 11-12: G1 & G2 available

db.Booking.findAll = async () => {
  return [
    { ground: { name: 'G1' }, startTime: new Date('2026-04-12T00:30:00.000Z'), endTime: new Date('2026-04-12T02:30:00.000Z') }, // 6-8 AM IST
    { ground: { name: 'G2' }, startTime: new Date('2026-04-12T02:30:00.000Z'), endTime: new Date('2026-04-12T03:30:00.000Z') }, // 8-9 AM IST (Hour 8)
    { ground: { name: 'G1' }, startTime: new Date('2026-04-12T03:30:00.000Z'), endTime: new Date('2026-04-12T04:30:00.000Z') }, // 9-10 AM IST (Hour 9)
    { ground: { name: 'G2' }, startTime: new Date('2026-04-12T04:30:00.000Z'), endTime: new Date('2026-04-12T05:30:00.000Z') }  // 10-11 AM IST (Hour 10)
  ];
};

(async () => {
  try {
    await getSmartBookingOptions(req, res);
    console.log("DONE!");
    process.exit(0);
  } catch (err) {
    console.error("CRASHED:", err);
    process.exit(1);
  }
})();
