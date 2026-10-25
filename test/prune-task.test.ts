import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseOlderThan } from '#src/runtime/tasks/prune'

describe('cleanup olderThan', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([undefined, ''])('treats %j as unset without a warning', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseOlderThan(value)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    [3600, 3600],
    ['3600', 3600],
    [0.5, 0.5],
    [0, 0],
    ['0', 0],
  ])('reads %j as %d seconds', (value, seconds) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseOlderThan(value)).toBe(seconds)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([-1, '-1', 'abc', ' ', Number.NaN, Number.POSITIVE_INFINITY, null, true, {}])('warns and treats %j as unset', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseOlderThan(value)).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})
