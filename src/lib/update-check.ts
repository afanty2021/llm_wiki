/**
 * Lightweight update checker: hits the GitHub Releases API for the
 * repo's `latest` release, compares against the app's build-time
 * version, and returns a status the UI can surface. We intentionally
 * don't download or install — the user gets a "new version available"
 * hint in Settings → About and a button that opens the GitHub
 * release page in their browser. See `update-store.ts` for the UI
 * state layer and `about-section.tsx` for the surfacing.
 *
 * Why not tauri-plugin-updater: a real auto-install flow needs Tauri-
 * signed release manifests plus a paid Windows code-signing cert to
 * avoid SmartScreen warnings. Worth doing later, but for a free OSS
 * distribution a polite "here's the new version, click to download"
 * covers 95% of the value.
 */

import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"

/** The subset of the GitHub release API response we care about. */
export interface GithubRelease {
  tag_name: string          // e.g. "v0.3.10"
  name: string              // display title
  body: string              // markdown release notes
  html_url: string          // browser URL for the release page
  published_at: string      // ISO timestamp
}

export type UpdateStatus =
  | { kind: "available"; local: string; remote: string; release: GithubRelease }
  | { kind: "up-to-date"; local: string; remote: string }
  | { kind: "error"; local: string; message: string }

/**
 * Strict semver-ish comparison of two "MAJOR.MINOR.PATCH" strings.
 * We don't use pre-release tags or build metadata in this project, so
 * a plain three-component numeric compare is enough and avoids pulling
 * in the `semver` npm package just for this.
 *
 * Returns true iff `remote` is strictly greater than `local`. A leading
 * `v` on either side is tolerated; anything non-numeric in a slot
 * defaults to 0 (so a weirdly-shaped remote tag can't trigger a false
 * upgrade).
 */
export function isNewer(remote: string, local: string): boolean {
  const parse = (s: string): [number, number, number] => {
    const [a = 0, b = 0, c = 0] = s
      .replace(/^v/, "")
      .split(".")
      .map((n) => {
        const v = parseInt(n, 10)
        return Number.isFinite(v) ? v : 0
      })
    return [a, b, c]
  }
  const [ra, rb, rc] = parse(remote)
  const [la, lb, lc] = parse(local)
  if (ra !== la) return ra > la
  if (rb !== lb) return rb > lb
  return rc > lc
}

/**
 * Fetch the latest release from a GitHub repo. Returns null on any
 * failure (network / rate-limit / 404 when no release exists yet).
 * Doesn't throw — the caller's job is to render the failure as an
 * "error" status, not to log it or alert the user.
 *
 * Routes through the Tauri HTTP plugin so it stays consistent with the
 * rest of the app's third-party traffic and doesn't depend on the
 * webview's CORS policy for api.github.com (which is permissive today
 * but might not always be).
 */
export async function fetchLatestRelease(
  repo: string,
): Promise<GithubRelease | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  try {
    const httpFetch = await getHttpFetch()
    const resp = await httpFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    if (!resp.ok) return null
    const data = await resp.json()
    // Duck-type the response shape — GitHub occasionally adds fields
    // but the ones below have been stable since the API's v3 days.
    if (
      typeof data?.tag_name === "string" &&
      typeof data?.html_url === "string"
    ) {
      return {
        tag_name: data.tag_name,
        name: typeof data.name === "string" ? data.name : data.tag_name,
        body: typeof data.body === "string" ? data.body : "",
        html_url: data.html_url,
        published_at:
          typeof data.published_at === "string" ? data.published_at : "",
      }
    }
    return null
  } catch (err) {
    if (isFetchNetworkError(err)) return null
    return null
  }
}

/**
 * End-to-end check: fetch + compare + package into a renderable
 * status. Callers pass in `currentVersion` from the build-time define
 * and `repo` from the project config — the module itself stays free
 * of environment coupling so it's easy to unit-test.
 */
export async function checkForUpdates(opts: {
  currentVersion: string
  repo: string
}): Promise<UpdateStatus> {
  const { currentVersion, repo } = opts
  const release = await fetchLatestRelease(repo)
  if (!release) {
    return {
      kind: "error",
      local: currentVersion,
      message: "Could not reach GitHub Releases API.",
    }
  }
  const remote = release.tag_name
  if (isNewer(remote, currentVersion)) {
    return {
      kind: "available",
      local: currentVersion,
      remote,
      release,
    }
  }
  return { kind: "up-to-date", local: currentVersion, remote }
}

/** Cache duration: don't re-hit the API if we checked more recently than this. */
export const UPDATE_CHECK_CACHE_MS = 6 * 60 * 60 * 1000 // 6 hours
