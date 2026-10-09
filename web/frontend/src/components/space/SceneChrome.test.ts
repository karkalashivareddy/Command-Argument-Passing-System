import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import { CAMERA_PRESETS, fitBoundsDistance, type SceneBounds } from "./SceneChrome";

describe("Process Space camera framing", () => {
  const bounds: SceneBounds = {
    center: new Vector3(0, 0, 13),
    radius: 20,
    min: new Vector3(-6, -2, 0),
    max: new Vector3(6, 2, 26),
  };

  it("fits the observed screen plane and leaves depth clearance", () => {
    const direction = new Vector3(...CAMERA_PRESETS.tree.direction);
    const distance = fitBoundsDistance(bounds, direction, 45, 1.6);
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThan(13);
    expect(distance).toBeLessThan(32);
  });

  it("moves the camera back for a narrow viewport", () => {
    const direction = new Vector3(...CAMERA_PRESETS.orbit.direction);
    const wide = fitBoundsDistance(bounds, direction, 45, 1.6);
    const narrow = fitBoundsDistance(bounds, direction, 45, 0.55);
    expect(narrow).toBeGreaterThan(wide);
  });
});
