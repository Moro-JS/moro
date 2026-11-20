// Minimal stand-in for `bullmq`, which is an optional peer and is not
// installed in this repository: a Queue and a Worker that keep the options
// they were constructed with, so a test can see which Redis connection the
// Bull adapter hands them.
'use strict';

class Queue {
  constructor(name, options) {
    this.name = name;
    this.options = options;
  }
  async add(name, data, options) {
    return { id: '1', name, data, opts: options || {}, attemptsMade: 0, timestamp: 0 };
  }
  async addBulk(jobs) {
    return jobs.map((job, index) => ({
      id: String(index + 1),
      name: job.name,
      data: job.data,
      opts: job.opts || {},
      attemptsMade: 0,
      timestamp: 0,
    }));
  }
  async close() {}
}

class Worker {
  constructor(name, processor, options) {
    this.name = name;
    this.options = options;
  }
  on() {}
  async close() {}
}

module.exports = { Queue, Worker };
