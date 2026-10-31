/**
 * Reads a Strava account export (Strava.com → Settings → My Account → Download or Delete Your
 * Account) in the browser: activities.csv for each activity's id, name and type, and the original
 * GPS files beside it (GPX, TCX or FIT, often gzipped). Only the zip's directory and the files
 * needed are read, so a multi-gigabyte export (photos and all) doesn't have to fit in memory.
 */
import { encodePolyline } from './polyline'
import { modeFor } from './sports'

/** Activities per upload. */
export const IMPORT_BATCH = 20

export const STRAVA_FULL_MESSAGE =
  "floodfill.world has reached Strava's limit on connected athletes. Import your Strava export instead, and we'll email you when you can connect."

/** Matches ImportedActivity in src/server/sync.ts. */
export type ExportActivity = {
  id: number
  name: string
  sportType: string
  startDate: string
  distanceM: number
  movingTimeS: number
  polyline: string
}

export type ImportProgress = { read: number; total: number; added: number; noGps: number }

export class ExportError extends Error {}

/**
 * Reads every foot and bike activity with GPS from the export and hands them to `upload` in
 * batches, which returns how many were new.
 */
export async function importStravaExport(
  file: Blob,
  upload: (batch: ExportActivity[]) => Promise<number>,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportProgress> {
  const entries = await readZipEntries(file)
  const csv = entries.get('activities.csv') ?? [...entries.values()].find((e) => e.name.endsWith('/activities.csv'))
  if (!csv) throw new ExportError("This doesn't look like a Strava export: it has no activities.csv.")
  // Some unzip-and-rezip tools add a top folder.
  const prefix = csv.name.slice(0, -'activities.csv'.length)
  const rows = activitiesFromCsv(new TextDecoder().decode(await readEntry(file, csv))).filter((a) => modeFor(a.sportType))

  const progress: ImportProgress = { read: 0, total: rows.length, added: 0, noGps: 0 }
  onProgress({ ...progress })
  let batch: ExportActivity[] = []
  for (const row of rows) {
    const entry = entries.get(prefix + row.file)
    const track = entry ? await readTrack(file, entry).catch(() => null) : null
    progress.read++
    if (track && track.points.length >= 2) batch.push(toActivity(row, track))
    else progress.noGps++
    if (batch.length === IMPORT_BATCH) {
      progress.added += await upload(batch)
      batch = []
    }
    onProgress({ ...progress })
  }
  if (batch.length > 0) progress.added += await upload(batch)
  onProgress({ ...progress })
  return progress
}

// ── activities.csv ───────────────────────────────────────────────────────────

export type CsvActivity = { id: number; name: string; sportType: string; date: string; movingTimeS: number; file: string }

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Strava's labels ("Trail Run", "E-Bike Ride") as API sport types ("TrailRun", "EBikeRide"). */
export const sportTypeFor = (label: string) => label.replace(/[^A-Za-z]/g, '')

/** One row per activity that has a GPS file. Columns are found by name, else where Strava puts them. */
export function activitiesFromCsv(text: string): CsvActivity[] {
  const [header = [], ...rows] = parseCsv(text.replace(/^﻿/, ''))
  const col = (name: string, fallback: number) => {
    const i = header.indexOf(name)
    return i >= 0 ? i : fallback
  }
  const id = col('Activity ID', 0)
  const date = col('Activity Date', 1)
  const name = col('Activity Name', 2)
  const type = col('Activity Type', 3)
  const time = col('Moving Time', col('Elapsed Time', 5))
  const file = header.indexOf('Filename')
  return rows.flatMap((r) => {
    const activityId = Number(r[id])
    const path = (file >= 0 ? r[file] : r.find((v) => v.startsWith('activities/'))) ?? ''
    if (!Number.isSafeInteger(activityId) || activityId <= 0 || !path) return []
    return [
      {
        id: activityId,
        name: r[name] ?? '',
        sportType: sportTypeFor(r[type] ?? ''),
        date: r[date] ?? '',
        movingTimeS: Math.round(Number(r[time]) || 0),
        file: path,
      },
    ]
  })
}

// ── GPS files ────────────────────────────────────────────────────────────────

/** [lat, lng] points, and when the first one was recorded (ms), if the file says. */
export type Track = { points: [number, number][]; start: number | null }

/** Points closer than this to the last one kept are dropped; matching needs far fewer than 1 a second. */
const THIN_M = 8

function toActivity(row: CsvActivity, track: Track): ExportActivity {
  const kept: [number, number][] = [track.points[0]]
  let distanceM = 0
  for (let i = 1; i < track.points.length; i++) {
    distanceM += meters(track.points[i - 1], track.points[i])
    if (meters(kept[kept.length - 1], track.points[i]) >= THIN_M || i === track.points.length - 1) kept.push(track.points[i])
  }
  // The CSV's date is UTC, e.g. "Jan 5, 2020, 3:04:05 PM".
  const csvDate = Date.parse(`${row.date} UTC`)
  const start = track.start ?? (Number.isNaN(csvDate) ? 0 : csvDate)
  return {
    id: row.id,
    name: row.name.slice(0, 300),
    sportType: row.sportType,
    startDate: new Date(start).toISOString(),
    distanceM: Math.round(distanceM),
    movingTimeS: row.movingTimeS,
    polyline: encodePolyline(kept),
  }
}

function meters([lat1, lng1]: [number, number], [lat2, lng2]: [number, number]) {
  const x = (lng2 - lng1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180)
  const y = lat2 - lat1
  return Math.sqrt(x * x + y * y) * 111_195
}

const validPoint = ([lat, lng]: [number, number]) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)

async function readTrack(file: Blob, entry: ZipEntry): Promise<Track | null> {
  let data = await readEntry(file, entry)
  let name = entry.name.toLowerCase()
  if (name.endsWith('.gz')) {
    data = await decompress(new Blob([data]), 'gzip')
    name = name.slice(0, -3)
  }
  if (name.endsWith('.fit')) return parseFit(data)
  const text = new TextDecoder().decode(data).trim()
  if (name.endsWith('.gpx')) return parseXmlTrack(text, 'trkpt')
  if (name.endsWith('.tcx')) return parseXmlTrack(text, 'Trackpoint')
  return null
}

/** GPX trkpt (lat/lon attributes) or TCX Trackpoint (Position children) elements. */
function parseXmlTrack(text: string, tag: 'trkpt' | 'Trackpoint'): Track {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const points: [number, number][] = []
  let start: number | null = null
  for (const el of doc.getElementsByTagName(tag)) {
    const child = (name: string) => el.getElementsByTagName(name)[0]?.textContent ?? ''
    const p: [number, number] =
      tag === 'trkpt'
        ? [Number(el.getAttribute('lat')), Number(el.getAttribute('lon'))]
        : [Number(child('LatitudeDegrees') || NaN), Number(child('LongitudeDegrees') || NaN)]
    if (!validPoint(p)) continue
    points.push(p)
    if (start === null) {
      const t = Date.parse(child(tag === 'trkpt' ? 'time' : 'Time'))
      if (!Number.isNaN(t)) start = t
    }
  }
  return { points, start }
}

/** FIT timestamps count seconds from 1989-12-31T00:00:00Z. */
const FIT_EPOCH_S = 631_065_600
const SEMICIRCLES = 180 / 2 ** 31
const RECORD = 20
const TIMESTAMP = 253

type FitDefinition = { global: number; little: boolean; fields: { num: number; size: number }[]; devSize: number }

/**
 * The positions in a FIT file's record messages. Reads only what it needs: definition messages,
 * and position and timestamp fields. Stops quietly at anything malformed, keeping what it read.
 */
export function parseFit(buf: ArrayBuffer): Track {
  const v = new DataView(buf)
  const points: [number, number][] = []
  let start: number | null = null
  let pos = 0
  try {
    // A file can hold several FIT files back to back.
    while (pos + 12 <= v.byteLength) {
      const headerSize = v.getUint8(pos)
      const dataSize = v.getUint32(pos + 4, true)
      const magic = String.fromCharCode(v.getUint8(pos + 8), v.getUint8(pos + 9), v.getUint8(pos + 10), v.getUint8(pos + 11))
      if (headerSize < 12 || magic !== '.FIT') break
      const end = Math.min(v.byteLength, pos + headerSize + dataSize)
      const defs = new Map<number, FitDefinition>()
      let lastTs = 0
      let p = pos + headerSize

      const readData = (def: FitDefinition, compressedTs: number | null) => {
        let lat: number | null = null
        let lng: number | null = null
        let ts = compressedTs
        for (const f of def.fields) {
          if (f.num === TIMESTAMP && f.size === 4) {
            const t = v.getUint32(p, def.little)
            if (t !== 0xffffffff) ts = lastTs = t
          } else if (def.global === RECORD && f.size === 4 && (f.num === 0 || f.num === 1)) {
            const raw = v.getInt32(p, def.little)
            if (raw !== 0x7fffffff) {
              if (f.num === 0) lat = raw * SEMICIRCLES
              else lng = raw * SEMICIRCLES
            }
          }
          p += f.size
        }
        p += def.devSize
        if (def.global === RECORD && lat !== null && lng !== null && validPoint([lat, lng])) {
          points.push([lat, lng])
          if (start === null && ts !== null) start = (ts + FIT_EPOCH_S) * 1000
        }
      }

      while (p < end) {
        const header = v.getUint8(p++)
        if (header & 0x80) {
          // Compressed timestamp header: a data message whose time is an offset from the last one.
          const def = defs.get((header >> 5) & 0x3)
          if (!def) break
          const offset = header & 0x1f
          lastTs = (lastTs - (lastTs & 0x1f)) + offset + (offset < (lastTs & 0x1f) ? 0x20 : 0)
          readData(def, lastTs)
        } else if (header & 0x40) {
          const little = v.getUint8(p + 1) === 0
          const def: FitDefinition = { global: v.getUint16(p + 2, little), little, fields: [], devSize: 0 }
          const count = v.getUint8(p + 4)
          p += 5
          for (let i = 0; i < count; i++, p += 3) def.fields.push({ num: v.getUint8(p), size: v.getUint8(p + 1) })
          if (header & 0x20) {
            const devCount = v.getUint8(p++)
            for (let i = 0; i < devCount; i++, p += 3) def.devSize += v.getUint8(p + 1)
          }
          defs.set(header & 0x0f, def)
        } else {
          const def = defs.get(header & 0x0f)
          if (!def) break
          readData(def, null)
        }
      }
      pos = end + 2 // CRC
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err
  }
  return { points, start }
}

// ── Zip ──────────────────────────────────────────────────────────────────────

type ZipEntry = { name: string; method: number; compressedSize: number; offset: number }

const u16 = (v: DataView, o: number) => v.getUint16(o, true)
const u32 = (v: DataView, o: number) => v.getUint32(o, true)
const u64 = (v: DataView, o: number) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 2 ** 32

const NOT_ZIP = "That file isn't a zip archive. Upload the export zip from Strava as it arrived."

/** The archive's directory, by file name. Handles Zip64, which exports over 4 GB use. */
async function readZipEntries(file: Blob): Promise<Map<string, ZipEntry>> {
  // The end record is in the last 22 bytes, plus a comment of up to 64 KB.
  const tailStart = Math.max(0, file.size - 65_557)
  const tail = new DataView(await file.slice(tailStart).arrayBuffer())
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ExportError(NOT_ZIP)
  let count = u16(tail, eocd + 10)
  let dirSize = u32(tail, eocd + 12)
  let dirOffset = u32(tail, eocd + 16)
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || u32(tail, locator) !== 0x07064b50) throw new ExportError(NOT_ZIP)
    const at = u64(tail, locator + 8)
    const record = new DataView(await file.slice(at, at + 56).arrayBuffer())
    if (u32(record, 0) !== 0x06064b50) throw new ExportError(NOT_ZIP)
    count = u64(record, 32)
    dirSize = u64(record, 40)
    dirOffset = u64(record, 48)
  }

  const dir = new DataView(await file.slice(dirOffset, dirOffset + dirSize).arrayBuffer())
  const decoder = new TextDecoder()
  const entries = new Map<string, ZipEntry>()
  for (let p = 0, i = 0; i < count && p + 46 <= dir.byteLength && u32(dir, p) === 0x02014b50; i++) {
    const nameLength = u16(dir, p + 28)
    const extraLength = u16(dir, p + 30)
    let size = u32(dir, p + 24)
    let compressedSize = u32(dir, p + 20)
    let offset = u32(dir, p + 42)
    // Zip64 keeps the values that overflowed in an extra field, in this order.
    for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength; e += 4 + u16(dir, e + 2)) {
      if (u16(dir, e) !== 0x0001) continue
      let q = e + 4
      if (size === 0xffffffff) {
        size = u64(dir, q)
        q += 8
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = u64(dir, q)
        q += 8
      }
      if (offset === 0xffffffff) offset = u64(dir, q)
    }
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength))
    entries.set(name, { name, method: u16(dir, p + 10), compressedSize, offset })
    p += 46 + nameLength + extraLength + u16(dir, p + 32)
  }
  return entries
}

async function readEntry(file: Blob, entry: ZipEntry): Promise<ArrayBuffer> {
  const local = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer())
  if (u32(local, 0) !== 0x04034b50) throw new ExportError(`Couldn't read ${entry.name} from the zip.`)
  const start = entry.offset + 30 + u16(local, 26) + u16(local, 28)
  const data = file.slice(start, start + entry.compressedSize)
  if (entry.method === 0) return data.arrayBuffer()
  if (entry.method === 8) return decompress(data, 'deflate-raw')
  throw new ExportError(`Couldn't read ${entry.name}: it uses an unsupported compression method.`)
}

function decompress(data: Blob, format: 'gzip' | 'deflate-raw'): Promise<ArrayBuffer> {
  return new Response(data.stream().pipeThrough(new DecompressionStream(format))).arrayBuffer()
}
