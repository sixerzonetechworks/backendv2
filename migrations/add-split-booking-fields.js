/**
 * Migration: Add Smart Split Booking columns to Bookings table
 * 
 * Adds:
 * - splitBookingId (STRING, nullable) - UUID grouping split booking rows
 * - splitType (ENUM 'single'|'split', default 'single') - booking type
 * - Index on splitBookingId
 * 
 * Run: node backendv2/migrations/add-split-booking-fields.js
 */

import 'dotenv/config';
import db from '../models/index.js';

const { sequelize, Sequelize } = db;

async function migrate() {
  try {
    await sequelize.authenticate();
    console.log('✓ Connected to database');

    const qi = sequelize.getQueryInterface();

    // 1. Add splitBookingId column
    try {
      await qi.addColumn('Bookings', 'splitBookingId', {
        type: Sequelize.DataTypes.STRING,
        allowNull: true
      });
      console.log('✅ Added splitBookingId column');
    } catch (e) {
      if (e.message.includes('already exists') || e.original?.message?.includes('already exists')) {
        console.log('⚠️  splitBookingId column already exists, skipping');
      } else {
        throw e;
      }
    }

    // 2. Create ENUM type for splitType (may already exist)
    try {
      await sequelize.query(`CREATE TYPE "enum_Bookings_splitType" AS ENUM ('single', 'split');`);
      console.log('✅ Created splitType ENUM type');
    } catch (e) {
      if (e.message.includes('already exists') || e.original?.message?.includes('already exists')) {
        console.log('⚠️  splitType ENUM type already exists, skipping');
      } else {
        throw e;
      }
    }

    // 3. Add splitType column
    try {
      await qi.addColumn('Bookings', 'splitType', {
        type: Sequelize.DataTypes.ENUM('single', 'split'),
        allowNull: false,
        defaultValue: 'single'
      });
      console.log('✅ Added splitType column');
    } catch (e) {
      if (e.message.includes('already exists') || e.original?.message?.includes('already exists')) {
        console.log('⚠️  splitType column already exists, skipping');
      } else {
        throw e;
      }
    }

    // 4. Add index on splitBookingId
    try {
      await qi.addIndex('Bookings', ['splitBookingId'], {
        name: 'bookings_split_booking_id'
      });
      console.log('✅ Added index on splitBookingId');
    } catch (e) {
      if (e.message.includes('already exists') || e.original?.message?.includes('already exists')) {
        console.log('⚠️  Index already exists, skipping');
      } else {
        throw e;
      }
    }

    console.log('\n✅ Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

migrate();
