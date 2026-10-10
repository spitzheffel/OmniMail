/*
 * D1 stand-ins for the iCloud integration suites: they wrap the real binding
 * so a test can land a write at an exact point, or take a table offline.
 */

/**
 * Run `before` between the bind and the run of the first prepared statement
 * matching `needle`. The store only ever calls .bind().run() on the statement
 * we intercept, so the narrow stand-in is enough.
 */
export function racingDb(db: D1Database, needle: string, before: () => Promise<unknown>): D1Database {
  let armed = true
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      if (!armed || !sql.includes(needle)) return statement
      armed = false
      return {
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args)
          return { run: async () => { await before(); return bound.run() } } as D1PreparedStatement
        },
      } as D1PreparedStatement
    },
  } as D1Database
}

/**
 * Append the SQL of every statement to `log` once D1 has finished running it,
 * in completion order: a write merely started before some point would still be
 * lost if the request ended there. Covers the bind().run/first/all chains the
 * iCloud store uses.
 */
export function recordingDb(db: D1Database, log: string[]): D1Database {
  const recorded = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const settle = async <T>(result: Promise<T>): Promise<T> => {
      const value = await result
      log.push(sql)
      return value
    }
    return {
      bind: (...values: unknown[]) => recorded(statement.bind(...values), sql),
      run: () => settle(statement.run()),
      first: (column?: string) => settle(column ? statement.first(column) : statement.first()),
      all: () => settle(statement.all()),
    } as D1PreparedStatement
  }
  return { prepare: (sql: string) => recorded(db.prepare(sql), sql) } as D1Database
}

/** Make every statement touching `needle` fail, as a D1 outage would. */
export function failingDb(db: D1Database, needle: string): D1Database {
  return {
    prepare(sql: string) {
      if (!sql.includes(needle)) return db.prepare(sql)
      const boom = async () => { throw new Error('D1_ERROR: database is unavailable') }
      return { bind: () => ({ first: boom, run: boom, all: boom }) } as unknown as D1PreparedStatement
    },
  } as D1Database
}
