const conversationId = 'c749a55b-4a4c-41af-b496-559f37a7fd35';

const response = await fetch(`http://localhost:3000/api/conversations/${conversationId}`);
const data = await response.json();

console.log('API Response:');
console.log('  Conversation ID:', data.conversation?.id || 'missing');
console.log('  Message count:', data.messages?.length || 0);
console.log('  Total memories:', data.memories?.length || 0);

if (data.memories) {
  const nonSummary = data.memories.filter((m: any) => m.type !== 'summary');
  console.log('  Non-summary memories:', nonSummary.length);

  console.log('\nMemory types:');
  const byType: Record<string, number> = {};
  for (const m of data.memories) {
    byType[m.type] = (byType[m.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType)) {
    console.log(`    ${type}: ${count}`);
  }
}
