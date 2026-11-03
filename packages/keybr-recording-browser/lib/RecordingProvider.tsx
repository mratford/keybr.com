import { type KeyboardCatalogue, type KeyboardLayout } from "@keybr/recording";
import { type ReactNode, useSyncExternalStore } from "react";
import { FormattedMessage, type IntlShape, useIntl } from "react-intl";
import { RecordingContext } from "./context.ts";
import {
  type RecordingActivity,
  RecordingRuntime,
  type RecordingSelection,
  type RecordingState,
} from "./runtime.ts";

let runtime: RecordingRuntime | undefined;
const initialState: RecordingState = {
  options: null,
  activity: null,
  status: null,
  keyboards: null,
  selection: null,
};
const getSnapshot = () => runtime?.state ?? initialState;
function subscribe(listener: () => void) {
  const current = (runtime ??= new RecordingRuntime());
  current.listeners.add(listener);
  void current.start();
  return () => {
    current.listeners.delete(listener);
  };
}

export function RecordingProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const state = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => initialState,
  );
  return (
    <RecordingContext.Provider value={state.options}>
      {children}
      {state.keyboards && (
        <RecordingSelector
          state={state}
          onSelect={(selection) => runtime?.select(selection)}
        />
      )}
      {(state.activity || state.status) && (
        <small role="status">
          <FormattedMessage
            id="recording.status"
            defaultMessage="Recording: {status}"
            values={{
              status: [
                state.activity && <RecordingActivityText {...state.activity} />,
                state.status,
              ]
                .filter(Boolean)
                .map((part, index) => (
                  <span key={index}>
                    {index > 0 && "; "}
                    {part}
                  </span>
                )),
            }}
          />
        </small>
      )}
    </RecordingContext.Provider>
  );
}

const short = (version: string) => version.slice(0, 8);

/** Whether recording is active, and what to do when it is not. */
export function RecordingActivityText(activity: RecordingActivity): ReactNode {
  const intl = useIntl();
  switch (activity.type) {
    case "active":
      return (
        <FormattedMessage
          id="recording.active"
          defaultMessage="active on {keyboard}, {layout}"
          values={{
            keyboard: activity.keyboard.name,
            layout: layoutLabel(intl, activity.keyboard, activity.layout),
          }}
        />
      );
    case "no-keyboards":
      return (
        <FormattedMessage
          id="recording.noKeyboards"
          defaultMessage="inactive; no keyboards imported (keybr recording import-keyboards)"
        />
      );
    case "choose-keyboard":
      return (
        <FormattedMessage
          id="recording.chooseKeyboard"
          defaultMessage="inactive; choose a keyboard and layout"
        />
      );
    case "keyboard-unavailable":
      return (
        <FormattedMessage
          id="recording.keyboardUnavailable"
          defaultMessage="inactive; the remembered keyboard {keyboard} is not available, choose a keyboard and layout"
          values={{ keyboard: activity.keyboard }}
        />
      );
    case "choose-layout":
      return (
        <FormattedMessage
          id="recording.chooseLayout"
          defaultMessage="inactive; choose a layout for {keyboard}"
          values={{ keyboard: activity.keyboard }}
        />
      );
    case "layout-unavailable":
      return (
        <FormattedMessage
          id="recording.layoutUnavailable"
          defaultMessage="inactive; the remembered layout {layout} ({version}) is not available, choose a layout"
          values={{
            layout: activity.keymap.id,
            version: short(activity.keymap.version),
          }}
        />
      );
  }
}

/**
 * A plain label: Letter layout and the saved .vil version, as typokiller names it.
 * It adds only the details needed to tell this layout apart from the keyboard's
 * other layouts: the keyboard definition, then the layer names, then, if labels
 * are still equal, the keymap snapshot version.
 */
export function layoutLabel(
  intl: IntlShape,
  keyboard: KeyboardCatalogue[number],
  layout: KeyboardLayout,
): string {
  const definitions = new Set(keyboard.layouts.map((l) => l.board.version));
  const same = (a: KeyboardLayout, b: KeyboardLayout) =>
    a.keymap.id === b.keymap.id && a.keymap.version === b.keymap.version;
  const others = keyboard.layouts.filter((l) => !same(l, layout));
  const label = (l: KeyboardLayout, withVersion: boolean) => {
    const parts = [
      intl.formatMessage(
        {
          id: "recording.layoutLabel",
          defaultMessage: "{letterLayout} · {vil}",
        },
        { letterLayout: l.letterLayout, vil: short(l.vilHash) },
      ),
    ];
    if (definitions.size > 1)
      parts.push(
        intl.formatMessage(
          {
            id: "recording.layoutDefinition",
            defaultMessage: "keyboard definition {version}",
          },
          { version: short(l.board.version) },
        ),
      );
    // Same .vil under the same definition: only the layer names differ.
    if (
      keyboard.layouts.some(
        (o) =>
          !same(o, l) &&
          o.letterLayout === l.letterLayout &&
          o.vilHash === l.vilHash &&
          o.board.version === l.board.version,
      )
    )
      parts.push(
        l.layers.length
          ? intl.formatMessage(
              {
                id: "recording.layoutLayers",
                defaultMessage: "layers {layers}",
              },
              { layers: intl.formatList(l.layers, { type: "unit" }) },
            )
          : intl.formatMessage({
              id: "recording.layoutNoLayers",
              defaultMessage: "no layer names",
            }),
      );
    if (withVersion)
      parts.push(
        intl.formatMessage(
          {
            id: "recording.layoutVersion",
            defaultMessage: "version {version}",
          },
          { version: short(l.keymap.version) },
        ),
      );
    return parts.join(" · ");
  };
  const text = label(layout, false);
  return others.some((o) => label(o, false) === text)
    ? label(layout, true)
    : text;
}

/** The physical keyboard and saved layout, separate from keybr's virtual keyboard layout. */
export function RecordingSelector({
  state: { keyboards, selection },
  onSelect,
}: {
  readonly state: RecordingState;
  readonly onSelect: (selection: RecordingSelection | null) => void;
}) {
  const intl = useIntl();
  const keyboard = keyboards?.find((k) => k.id === selection?.keyboard);
  const layoutValue = (ref: { id: string; version: string }) =>
    `${ref.id}\n${ref.version}`;
  const selected = keyboard?.layouts.find(
    (l) =>
      selection?.keymap != null &&
      layoutValue(l.keymap) === layoutValue(selection.keymap),
  );
  const choose = intl.formatMessage({
    id: "recording.choose",
    defaultMessage: "Choose…",
  });
  return (
    <p>
      <label>
        <FormattedMessage id="recording.keyboard" defaultMessage="Keyboard" />{" "}
        <select
          value={keyboard?.id ?? ""}
          onChange={(event) =>
            onSelect(
              event.target.value
                ? { keyboard: event.target.value, keymap: null }
                : null,
            )
          }
        >
          <option value="">{choose}</option>
          {keyboards?.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        <FormattedMessage id="recording.layout" defaultMessage="Layout" />{" "}
        <select
          value={selected ? layoutValue(selected.keymap) : ""}
          disabled={keyboard == null}
          onChange={(event) => {
            const layout = keyboard?.layouts.find(
              (l) => layoutValue(l.keymap) === event.target.value,
            );
            onSelect({
              keyboard: keyboard!.id,
              keymap: layout ? layout.keymap : null,
            });
          }}
        >
          <option value="">{choose}</option>
          {keyboard?.layouts.map((l) => (
            <option key={layoutValue(l.keymap)} value={layoutValue(l.keymap)}>
              {layoutLabel(intl, keyboard, l)}
            </option>
          ))}
        </select>
      </label>
    </p>
  );
}
