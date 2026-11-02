import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// Same matchers as "@testing-library/jest-dom/vitest", registered explicitly: that entry imports `vitest`
// from inside the pnpm store and fails to resolve it on some installs. The type augmentation below is what
// that entry would have provided (kept so `tsc --noEmit` still knows toHaveTextContent & co.).
expect.extend(matchers);

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> extends TestingLibraryMatchers<ReturnType<typeof expect.stringContaining>, T> {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
