// The port allocator the suite shares (tests/setup.ts): every port it hands
// out is one a test can listen on and reach with fetch().
import { describe, it, expect } from '@jest/globals';
import { usableTestPort } from '../setup.js';

// fetch() decides that a port is a "bad port" before it connects, so a
// dispatcher that never connects is enough to ask it.
const noNetwork = {
  dispatch() {
    throw new Error('no network in this test');
  },
};
async function fetchRefusesPort(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { dispatcher: noNetwork } as any);
    return false;
  } catch (error: any) {
    return /bad port/i.test(String(error?.cause?.message ?? error?.message));
  }
}

// What a worker's allocator hands out, from the first port of its band
function band(workerId: number, count: number): number[] {
  const ports: number[] = [];
  let next = 3000 + workerId * 1000;
  for (let i = 0; i < count; i++) {
    const port = usableTestPort(next);
    ports.push(port);
    next = port + 1;
  }
  return ports;
}

describe('test port allocator', () => {
  it('hands out no port that fetch() refuses, in any worker band', async () => {
    const refused: number[] = [];
    for (let workerId = 1; workerId <= 16; workerId++) {
      for (const port of band(workerId, 1000)) {
        if (await fetchRefusesPort(port)) refused.push(port);
      }
    }
    expect(refused).toEqual([]);
    // The question is being asked: these are refused when asked directly
    expect(await fetchRefusesPort(6000)).toBe(true);
    expect(await fetchRefusesPort(4045)).toBe(true);
  });

  it('steps over the ports macOS itself listens on', () => {
    // AirPlay Receiver: the first port of workers 2 and 4
    expect(band(2, 3)).toEqual([5001, 5002, 5003]);
    expect(band(4, 3)).toEqual([7001, 7002, 7003]);
    // ftp-proxy, on loopback: the 22nd port of worker 5
    expect(band(5, 23).slice(20)).toEqual([8020, 8022, 8023]);
    expect(band(1, 3)).toEqual([4000, 4001, 4002]);
  });

  it('goes on counting from the port after the one it stepped over', () => {
    // 6665 to 6669 are all refused; 4045 and 6000 stand alone
    expect(usableTestPort(6665)).toBe(6670);
    expect(usableTestPort(4045)).toBe(4046);
    expect(band(3, 2)).toEqual([6001, 6002]);
    expect(usableTestPort(4046)).toBe(4046);
  });
});
