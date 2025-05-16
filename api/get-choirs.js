// File: /api/get-choirs.js (Vercel Serverless Function)

import { NextResponse } from 'next/server';

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const CHOIR_TABLE = 'Choirs';

export async function GET() {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(CHOIR_TABLE)}`, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    },
  });

  if (!res.ok) {
    return NextResponse.json({ error: 'Failed to fetch choir list' }, { status: 500 });
  }

  const data = await res.json();
  return NextResponse.json({ records: data.records });
}
