import { KeyboardOptions, Layout } from "@keybr/keyboard";
import { RecordingProvider } from "@keybr/recording-browser";
import { Settings } from "@keybr/settings";
import { ViewSwitch } from "@keybr/widget";
import { views } from "./views.tsx";

setDefaultLayout(window.navigator.language);

function setDefaultLayout(localeId: string) {
  const layout = Layout.findLayout(localeId);
  if (layout != null) {
    Settings.addDefaults(
      KeyboardOptions.default()
        .withLanguage(layout.language)
        .withLayout(layout)
        .save(new Settings()),
    );
  }
}

export function PracticePage() {
  return (
    <RecordingProvider>
      <ViewSwitch views={views} />
    </RecordingProvider>
  );
}
