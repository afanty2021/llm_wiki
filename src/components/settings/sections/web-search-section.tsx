import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function WebSearchSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const options = [
    { value: "none" as const, label: "Disabled" },
    { value: "tavily" as const, label: "Tavily" },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.webSearch.title")} (Deep Research)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.webSearch.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.webSearch.provider", { defaultValue: "Search Provider" })}</Label>
        <div className="flex flex-wrap gap-2">
          {options.map((p) => {
            const active = draft.searchProvider === p.value
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => setDraft("searchProvider", p.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      {draft.searchProvider !== "none" && (
        <div className="space-y-2">
          <Label>API Key</Label>
          <Input
            type="password"
            value={draft.searchApiKey}
            onChange={(e) => setDraft("searchApiKey", e.target.value)}
            placeholder="Enter your Tavily API key (tavily.com)"
          />
        </div>
      )}
    </div>
  )
}
