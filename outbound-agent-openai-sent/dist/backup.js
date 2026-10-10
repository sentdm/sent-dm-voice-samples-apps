import { appendFile, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
/** Owns the private data directory (.sent-agent): owner-only directory and files for the routing backup and call outcomes. */
export class BackupStore {
    dir;
    file;
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, 'routing-backup.json');
    }
    async appendOutcome(record) {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await appendFile(path.join(this.dir, 'call-outcomes.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
    }
    async read() {
        try {
            return JSON.parse(await readFile(this.file, 'utf8'));
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return null;
            throw e;
        }
    }
    async save(backup) {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const temp = this.file + '.tmp';
        await writeFile(temp, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, this.file);
    }
    async clear() { await unlink(this.file).catch(e => { if (e.code !== 'ENOENT')
        throw e; }); }
}
//# sourceMappingURL=backup.js.map