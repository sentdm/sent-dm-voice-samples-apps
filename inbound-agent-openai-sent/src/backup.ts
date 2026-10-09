import { appendFile, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
export interface RoutingBackup {
  number: string; previousUrl: string | null; installedUrl: string; callbackSecret?: string; createdAt: string;
}
/** Owns the private data directory (.sent-agent): owner-only directory and files for the routing backup and caller messages. */
export class BackupStore {
  private file: string;
  constructor(private dir: string) { this.file = path.join(dir, 'routing-backup.json'); }
  async appendMessage(record: object): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.dir, 'messages.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  async read(): Promise<RoutingBackup | null> {
    try { return JSON.parse(await readFile(this.file, 'utf8')) as RoutingBackup; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async save(backup: RoutingBackup): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = this.file + '.tmp';
    await writeFile(temp, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, this.file);
  }
  async clear(): Promise<void> { await unlink(this.file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
