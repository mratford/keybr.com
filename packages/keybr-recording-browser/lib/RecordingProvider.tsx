import { type ReactNode, useSyncExternalStore } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { RecordingContext } from "./context.ts";
import {
  layoutLabel,
  RecordingRuntime,
  type RecordingSelection,
  type RecordingState,
} from "./runtime.ts";

let runtime: RecordingRuntime | undefined;
const initialState: RecordingState = {
  options: null,
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
      {state.status && (
        <small role="status">
          <FormattedMessage
            id="recording.status"
            defaultMessage="Recording: {status}"
            values={{ status: state.status }}
          />
        </small>
      )}
    </RecordingContext.Provider>
  );
}

/** The physical keyboard and saved layout, separate from keybr's virtual keyboard layout. */
export function RecordingSelector({
  state: { keyboards, selection },
  onSelect,
}: {
  readonly state: RecordingState;
  readonly onSelect: (selection: RecordingSelection | null) => void;
}) {
  const { formatMessage } = useIntl();
  const keyboard = keyboards?.find((k) => k.id === selection?.keyboard);
  const layoutValue = (ref: { id: string; version: string }) =>
    `${ref.id}\n${ref.version}`;
  const selected = keyboard?.layouts.find(
    (l) =>
      selection?.keymap != null &&
      layoutValue(l.keymap) === layoutValue(selection.keymap),
  );
  const choose = formatMessage({
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
              {layoutLabel(keyboard, l)}
            </option>
          ))}
        </select>
      </label>
    </p>
  );
}
