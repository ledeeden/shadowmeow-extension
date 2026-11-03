import Dexie, { type EntityTable } from 'dexie';

// Extension-origin IndexedDB, never imported by the content script or exported.
class CredentialDatabase extends Dexie {
  credentials!: EntityTable<{ id: string; key: string }, 'id'>;
  constructor() { super('shadow-language-agent-credentials'); this.version(1).stores({ credentials: 'id' }); }
}
const vault = new CredentialDatabase();
export async function readKey() { return (await vault.credentials.get('deepseek'))?.key || ''; }
export async function saveKey(key: string) {
  if (key.trim()) await vault.credentials.put({ id: 'deepseek', key: key.trim() });
  else await vault.credentials.delete('deepseek');
}
