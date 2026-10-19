import { describe, expect, it } from 'vitest'
import { placeholder } from '../client'
import { createTestDb } from '../../../src/__tests__/helpers/createTestDb'

// Runs on SQLite by default; `DB=postgres TEST_POSTGRES_URL=…` exercises the
// postgres.js adapter, where a text column once stored arrays as '[object Object]'.
describe('JSON parameter binding', () => {
  it('round-trips plain objects and arrays through text and json columns', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const jsonType = db.dialect === 'postgres' ? 'jsonb' : 'text'
      await db.unsafe(`create table json_bind_probe (id text primary key, text_json text, doc_json ${jsonType})`)
      const blocks = [{ kind: 'text', text: 'hello' }, { kind: 'image', id: 'i1' }]
      const doc = { nested: { ok: true }, list: [1, 2] }

      await db`insert into json_bind_probe (id, text_json, doc_json) values (${'a'}, ${blocks}, ${doc})`
      const marks = [1, 2, 3].map((index) => placeholder(db.dialect, index)).join(', ')
      await db.unsafe(`insert into json_bind_probe (id, text_json, doc_json) values (${marks})`, ['b', blocks, doc])

      const { rows } = await db<{ id: string; text_json: unknown; doc_json: unknown }>`select id, text_json, doc_json from json_bind_probe order by id`
      expect(rows.map((row) => row.text_json)).toEqual([blocks, blocks])
      expect(rows.map((row) => row.doc_json)).toEqual([doc, doc])
    } finally {
      await cleanup()
    }
  })
})
