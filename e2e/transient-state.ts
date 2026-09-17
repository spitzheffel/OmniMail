import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Exit states such as `is-closing` or `data-state="closing"` exist only for the
 * duration of an animation, and the element usually unmounts right after. A
 * polling assertion samples that window rather than observing it, so on a
 * loaded machine it gets skipped past — or finds no element at all.
 *
 * Record the transition instead: mark `<body>`, which outlives the element,
 * from a MutationObserver, then assert the record once the element is gone.
 * `selector` is matched against `target` itself, so any CSS shape works —
 * including `:has()` for a descendant that only exists mid-flight, such as
 * `:has(.spinner)` on a dialog that is waiting for its request.
 */
export function watchTransientState(
  target: Locator,
  flag: string,
  selector: string,
): Promise<void> {
  return target.evaluate((element, [name, match]) => {
    const mark = () => {
      if (element.matches(match)) document.body.setAttribute(name, 'true')
    }
    document.body.setAttribute(name, 'false')
    mark()
    new MutationObserver(mark).observe(element, {
      attributes: true, childList: true, subtree: true,
    })
  }, [flag, selector] as const)
}

export function expectTransientStateSeen(page: Page, flag: string): Promise<void> {
  return expect(page.locator('body')).toHaveAttribute(flag, 'true')
}
