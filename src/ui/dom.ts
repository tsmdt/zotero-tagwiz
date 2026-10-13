type Child = Node | string | number | null | false | undefined;
type Props = Record<string, unknown>;

/**
 * Minimal element builder for the dialog (an XHTML document, so createElement
 * yields HTML elements). `on<event>` props become listeners, `class` sets the
 * class, anything that is a writable DOM property is assigned, the rest
 * (including read-only properties such as input.list) become attributes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (isAssignable(el, key)) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

/**
 * True if `obj[key]` can be assigned: a writable data property or an accessor
 * with a setter, found anywhere on the prototype chain. Assigning to a
 * getter-only property (e.g. HTMLInputElement.list) throws in strict mode,
 * which is how the bundled plugin runs.
 */
export function isAssignable(obj: object, key: string): boolean {
  for (let o: object | null = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return d.set !== undefined || d.writable === true;
  }
  return false;
}

export function append(parent: Node, children: readonly Child[]) {
  const doc = parent.ownerDocument!;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === "object" ? child : doc.createTextNode(String(child)),
    );
  }
}

/**
 * Wrap a text input with a small "×" button at its right edge that empties
 * it. Clearing fires the input's own `input` event, so its handler reacts as
 * if the user had deleted the text. CSS hides the button while the
 * placeholder shows, so the input needs a placeholder.
 */
export function clearable(
  doc: Document,
  input: HTMLInputElement,
  label: string,
): HTMLElement {
  const button = h(
    doc,
    "button",
    {
      type: "button",
      class: "tw-clear",
      // Not a tab stop of its own: the keyboard can select and delete.
      tabIndex: -1,
      title: label,
      "aria-label": label,
      onclick: () => {
        input.value = "";
        // The dialog window's Event: the plugin's scope may lack one.
        const { Event } = doc.defaultView!;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      },
    },
    "🅧",
  );
  return h(doc, "span", { class: "tw-clearable" }, input, button);
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
