// Minimal stand-in for the `drizzle-orm` operators the Drizzle adapter uses.
// drizzle-orm is an optional peer and is not installed in this repository.
// Mirrors the behaviours that matter for the tests: and() with no conditions
// returns undefined, which Drizzle's .where() treats as "no WHERE"; and the
// `sql` tag builds an object out of text chunks and the values between them,
// with sql.param() marking a value that is bound as one parameter.
'use strict';

function sql(strings, ...params) {
  return { kind: 'sql', strings: Array.from(strings), params };
}
sql.param = value => ({ kind: 'param', value });

module.exports = {
  sql,
  eq: (column, value) => ({ op: 'eq', column, value }),
  and: (...conditions) => {
    const present = conditions.filter(condition => condition !== undefined);
    if (present.length === 0) return undefined;
    if (present.length === 1) return present[0];
    return { op: 'and', conditions: present };
  },
};
