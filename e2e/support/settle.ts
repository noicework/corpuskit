import type { Page } from '@astral/astral'

/**
 * Waits until the element `selector` matches keeps the same box, and the page the same scroll
 * position, across two animation frames, so a click or a capture lands on settled layout rather
 * than on a node that is still moving or being replaced. Brings the page to the front first: a
 * background tab runs no animation frames.
 */
export async function settle(page: Page, selector: string): Promise<void> {
  await page.bringToFront()
  await page.waitForFunction(async (selector) => {
    const box = () => {
      const rect = document.querySelector(selector)?.getBoundingClientRect()
      return rect && [rect.x, rect.y, rect.width, rect.height, scrollX, scrollY].join()
    }
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const before = box()
    await frame()
    await frame()
    return before !== undefined && before === box()
  }, { args: [selector] })
}
