import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

// Same matchers as "@testing-library/jest-dom/vitest", registered explicitly: that entry imports `vitest`
// from inside the pnpm store and fails to resolve it on some installs.
expect.extend(matchers);
