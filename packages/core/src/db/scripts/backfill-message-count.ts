/**
 * Backfill message_count for existing sessions
 *
 * This script fixes the bug where message_count was never incremented,
 * causing fork_point_message_index and spawn_point_message_index to always be 0.
 *
 * For each session, it counts the actual messages and updates session.data.message_count.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createClient } from '@libsql/client';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { messages, sessions } from '../schema';

const AGOR_DB_PATH = process.env.AGOR_DB_PATH || resolve(homedir(), '.agor/agor.db');

async function main() {
  console.log('🔧 Backfilling message_count for existing sessions...\n');

  // Connect to database
  const client = createClient({ url: `file:${AGOR_DB_PATH}` });
  const db = drizzle(client);

  // Find all sessions
  const allSessions = await db.select().from(sessions).all();
  console.log(`Found ${allSessions.length} sessions total\n`);

  let updatedCount = 0;
  let totalMessages = 0;

  // Process each session
  for (const session of allSessions) {
    // Count actual messages for this session
    const messageCountResult = await db
      .select({ count: count() })
      .from(messages)
      .where(eq(messages.session_id, session.session_id))
      .all();

    const actualMessageCount = messageCountResult[0]?.count || 0;
    const currentMessageCount = (session.data as { message_count?: number }).message_count || 0;

    // Skip if already correct
    if (actualMessageCount === currentMessageCount) {
      continue;
    }

    console.log(
      `Session ${session.session_id.substring(0, 8)}: ${currentMessageCount} → ${actualMessageCount} messages`
    );

    // Update session.data.message_count
    const updatedData = {
      ...session.data,
      message_count: actualMessageCount,
    };

    await db
      .update(sessions)
      .set({ data: updatedData })
      .where(eq(sessions.session_id, session.session_id))
      .run();

    updatedCount++;
    totalMessages += actualMessageCount;
  }

  console.log(`\n✅ Updated ${updatedCount} sessions (${totalMessages} messages counted)`);
  process.exit(0);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
