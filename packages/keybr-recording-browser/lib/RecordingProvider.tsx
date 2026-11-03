import { type ReactNode, useSyncExternalStore } from "react";
import { FormattedMessage } from "react-intl";
import { RecordingContext } from "./context.ts";
import { RecordingRuntime, type RecordingState } from "./runtime.ts";

let runtime: RecordingRuntime | undefined;
const initialState: RecordingState = { options: null, status: null };
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
