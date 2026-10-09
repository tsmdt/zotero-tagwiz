import { assert } from "chai";
import { isAssignable } from "../../src/ui/dom";

describe("isAssignable", function () {
  class Base {
    plain = 1;
    get readOnly() {
      return 2;
    }
    get both() {
      return 3;
    }
    set both(_value: number) {
      // setter present
    }
  }
  class Child extends Base {}

  it("accepts data properties and accessors with a setter", function () {
    const el = new Child();
    assert.isTrue(isAssignable(el, "plain"));
    assert.isTrue(isAssignable(el, "both"));
  });

  it("rejects getter-only properties (like HTMLInputElement.list)", function () {
    const el = new Child();
    assert.isFalse(isAssignable(el, "readOnly"));
    // and assigning really would throw in strict mode, which is the bug this guards
    assert.throws(() => {
      "use strict";
      (el as unknown as Record<string, unknown>).readOnly = 1;
    });
  });

  it("rejects unknown keys so they become attributes", function () {
    assert.isFalse(isAssignable(new Child(), "colspan"));
  });
});
