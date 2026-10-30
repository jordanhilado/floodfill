import { describe, expect, it } from 'vitest'
import { activitiesFromCsv, parseCsv, parseFit, sportTypeFor } from './strava-export'

describe('activities.csv', () => {
  it('parses quoted fields with commas, quotes and line breaks', () => {
    expect(parseCsv('a,"b, c","say ""hi""\nthere"\r\n1,2,3')).toEqual([
      ['a', 'b, c', 'say "hi"\nthere'],
      ['1', '2', '3'],
    ])
  })

  it('reads the columns Floodfill needs and skips activities without a GPS file', () => {
    const csv = [
      '﻿Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Filename,Moving Time',
      '101,"Jan 5, 2020, 3:04:05 PM",Morning Run,Run,"Easy, slow",1900,5.1,activities/101.fit.gz,1800.0',
      '102,"Jan 6, 2020, 3:04:05 PM",Yoga,Yoga,,3600,0,,3600',
      '103,"Jan 7, 2020, 3:04:05 PM",Commute,E-Bike Ride,,900,4,activities/103.gpx,850',
    ].join('\n')
    expect(activitiesFromCsv(csv)).toEqual([
      { id: 101, name: 'Morning Run', sportType: 'Run', date: 'Jan 5, 2020, 3:04:05 PM', movingTimeS: 1800, file: 'activities/101.fit.gz' },
      { id: 103, name: 'Commute', sportType: 'EBikeRide', date: 'Jan 7, 2020, 3:04:05 PM', movingTimeS: 850, file: 'activities/103.gpx' },
    ])
  })

  it('turns Strava labels into API sport types', () => {
    expect(sportTypeFor('Trail Run')).toBe('TrailRun')
    expect(sportTypeFor('E-Mountain Bike Ride')).toBe('EMountainBikeRide')
  })
})

describe('parseFit', () => {
  const SEMICIRCLES = 2 ** 31 / 180
  /** A FIT file with one record definition (timestamp, lat, lng) and a message per point. */
  function fit(points: [number, number, number][]) {
    const body: number[] = []
    const u16 = (n: number) => body.push(n & 0xff, (n >> 8) & 0xff)
    const u32 = (n: number) => body.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)
    body.push(0x40, 0, 0) // definition, local type 0, little-endian
    u16(20) // record
    body.push(3, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85)
    for (const [ts, lat, lng] of points) {
      body.push(0x00)
      u32(ts)
      u32(Math.round(lat * SEMICIRCLES) | 0)
      u32(Math.round(lng * SEMICIRCLES) | 0)
    }
    const header = [14, 0x10, 0, 0, ...new Uint8Array(new Uint32Array([body.length]).buffer), 0x2e, 0x46, 0x49, 0x54, 0, 0]
    return new Uint8Array([...header, ...body, 0, 0]).buffer
  }

  it('reads record positions and the first timestamp', () => {
    const track = parseFit(
      fit([
        [1_000_000_000, 37.7749, -122.4194],
        [1_000_000_001, 37.775, -122.4195],
      ]),
    )
    expect(track.points).toHaveLength(2)
    expect(track.points[0][0]).toBeCloseTo(37.7749, 5)
    expect(track.points[0][1]).toBeCloseTo(-122.4194, 5)
    expect(track.start).toBe((1_000_000_000 + 631_065_600) * 1000)
  })

  it('keeps what it read from a truncated file', () => {
    const whole = fit([
      [1, 37.7749, -122.4194],
      [2, 37.775, -122.4195],
    ])
    expect(parseFit(whole.slice(0, whole.byteLength - 8)).points).toHaveLength(1)
  })
})
