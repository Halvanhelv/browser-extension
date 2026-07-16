/**
 * GitHub-specific utilities for detecting issue/PR pages and extracting issue information
 */

import { apiClient } from "./api";
import { getCurrentTimeEntry, getLastUsedProjectId } from "./timeEntries";
import type { CreateTimeEntryBody } from "@solidtime/api";
import { accessToken } from "./oauth";
import { dayjs } from "./dayjs";

export interface GithubIssueInfo {
  issueKey: string;
  owner: string;
  repo: string;
  number: string;
  fullUrl: string;
}

const SECTION_ID = "solidtime-github-time-tracking-section";
const BUTTON_ID = "solidtime-github-start-tracking-btn";

const ISSUE_OR_PR_PATTERN = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/;

/**
 * Checks if the current page is a GitHub issue or pull request page
 */
export function isGithubIssuePage(): boolean {
  return ISSUE_OR_PR_PATTERN.test(window.location.pathname);
}

/**
 * Extracts issue information from the current GitHub issue/PR page
 */
export function getGithubIssueInfo(): GithubIssueInfo | null {
  const match = window.location.pathname.match(ISSUE_OR_PR_PATTERN);
  if (!match) {
    return null;
  }

  const [, owner, repo, , number] = match;

  return {
    issueKey: `${owner}/${repo}#${number}`,
    owner,
    repo,
    number,
    fullUrl: window.location.href,
  };
}

/**
 * Gets the issue/PR title from the DOM.
 * GitHub's React issue viewer puts data-testid="issue-title" directly on the <bdi> itself
 * (both on the standalone issue page and inside the Projects side panel, since they share
 * the same IssueViewer component).
 */
export function getIssueTitleFromDOM(root: ParentNode = document): string | null {
  const titleElement =
    root.querySelector('[data-testid="issue-title"]') ||
    root.querySelector("h1 bdi");

  if (titleElement) {
    return titleElement.textContent?.trim() || null;
  }

  return null;
}

const SIDEBAR_SECTION_ANCHOR_SELECTOR =
  '[data-testid="sidebar-assignees-section"], [data-testid="sidebar-labels-section"], [data-testid="sidebar-projects-section"], [data-testid="sidebar-milestones-section"]';

/**
 * Finds the sidebar container where we should inject the Time Tracking section.
 * GitHub's React issue viewer marks each sidebar section with a stable data-testid
 * (sidebar-assignees-section, sidebar-labels-section, etc) - find one and use its
 * parent as the shared sidebar container. Works identically for the standalone issue
 * page and the Projects v2 side panel, since both render the same IssueViewer component.
 */
export function findGithubSidebar(root: ParentNode = document): HTMLElement | null {
  const anchor = root.querySelector(SIDEBAR_SECTION_ANCHOR_SELECTOR);
  return (anchor?.parentElement as HTMLElement) || null;
}

/**
 * Extracts classes from an existing sidebar section to match GitHub's styling
 */
function extractGithubClasses(root: ParentNode = document) {
  const section = root.querySelector(SIDEBAR_SECTION_ANCHOR_SELECTOR);
  const heading = section?.querySelector("h3");

  return {
    sectionClass: section?.className || "",
    headingClass: heading?.className || "",
  };
}

// Solidtime's actual Start/Stop Timer button color (Tailwind sky accent,
// pulled from @solidtime/ui's styles.css --color-accent-* tokens), so the
// injected control looks like the real thing instead of a generic bordered box.
const SOLIDTIME_ACCENT = {
  dark: {
    background: "rgba(125, 211, 252, 0.1)",
    backgroundHover: "rgba(125, 211, 252, 0.2)",
    border: "rgba(125, 211, 252, 0.3)",
    text: "rgb(224, 242, 254)",
  },
  light: {
    background: "rgba(2, 132, 199, 0.9)",
    backgroundHover: "rgb(2, 132, 199)",
    border: "rgb(2, 132, 199)",
    text: "#ffffff",
  },
};

function isGithubDarkTheme(): boolean {
  return document.documentElement.getAttribute("data-color-mode") !== "light";
}

const PLAY_ICON_SVG =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="flex-shrink:0;"><path d="M1 0.5v9l8-4.5z"></path></svg>';
const STOP_ICON_SVG =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="flex-shrink:0;"><rect x="1" y="1" width="8" height="8" rx="1.5"></rect></svg>';

function styleGithubTimeTrackingButton(
  button: HTMLButtonElement,
  isTracking: boolean,
): void {
  const theme = isGithubDarkTheme()
    ? SOLIDTIME_ACCENT.dark
    : SOLIDTIME_ACCENT.light;

  // Keep the running state on the element so the click handler and the
  // focus-driven resync read one source of truth instead of a stale closure.
  button.dataset.tracking = String(isTracking);

  button.style.cssText = `display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; margin-top: 8px; border-radius: 9999px; border: 1px solid ${theme.border}; background: ${theme.background}; color: ${theme.text}; font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer; transition: background-color 0.15s ease;`;
  button.innerHTML = `${isTracking ? STOP_ICON_SVG : PLAY_ICON_SVG}<span>${isTracking ? "Stop Timer" : "Start Timer"}</span>`;

  button.onmouseenter = () => {
    button.style.backgroundColor = theme.backgroundHover;
  };
  button.onmouseleave = () => {
    button.style.backgroundColor = theme.background;
  };
}

/**
 * Creates the Time Tracking sidebar section
 */
function createGithubTimeTrackingSection(
  issueDescription: string,
  isTracking: boolean,
): HTMLElement {
  const classes = extractGithubClasses();

  const section = document.createElement("div");
  section.id = SECTION_ID;
  section.className = classes.sectionClass;
  // Stash the description so the focus-driven resync can recompute whether this
  // issue is the one currently being tracked without a captured closure.
  section.dataset.issueDescription = issueDescription;

  const heading = document.createElement("h3");
  heading.className = classes.headingClass;
  heading.textContent = "Time Tracking";
  section.appendChild(heading);

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  styleGithubTimeTrackingButton(button, isTracking);

  section.appendChild(button);

  return section;
}

/**
 * Injects the Time Tracking section into the GitHub sidebar
 */
export async function injectGithubTimeTrackingSection(
  sidebar: HTMLElement,
  issueDescription: string,
  skipExistingCheck = false,
): Promise<void> {
  const existingSection = document.getElementById(SECTION_ID);
  if (existingSection && !skipExistingCheck) {
    return;
  }

  if (existingSection) {
    existingSection.remove();
  }

  let isTracking = false;
  try {
    if (accessToken.value) {
      const currentEntry = await getCurrentTimeEntry();
      // Match on description, not just "any timer running" - otherwise starting
      // a timer on one issue marks every issue's button as tracking.
      isTracking = currentEntry?.data?.description === issueDescription;
    }
  } catch (error) {
    console.error("Failed to get current time entry:", error);
  }

  const section = createGithubTimeTrackingSection(
    issueDescription,
    isTracking,
  );
  // Prepend rather than append - GitHub's sidebar can run long (Assignees,
  // Labels, Projects, Milestone, Development, Notifications...), so appending
  // buries the section below the fold on most issues.
  sidebar.prepend(section);

  const button = document.getElementById(BUTTON_ID);
  if (button) {
    button.addEventListener("click", () =>
      // Read the live state off the element - the focus resync can flip it
      // after injection, so a captured isTracking would go stale.
      handleGithubTrackingClick(
        issueDescription,
        button.dataset.tracking === "true",
      ),
    );
  }
}

/**
 * Re-checks whether the sidebar section's issue is the one currently being
 * tracked and restyles its button to match. Called when the GitHub tab regains
 * focus, so stopping a timer from the extension popup (a separate context that
 * the content script can't observe) is reflected back on the page button.
 */
export async function refreshGithubSidebarButtonState(): Promise<void> {
  const section = document.getElementById(SECTION_ID);
  const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (!section || !button) {
    return;
  }

  const issueDescription = section.dataset.issueDescription || "";
  let isTracking = false;
  if (accessToken.value) {
    try {
      const currentEntry = await getCurrentTimeEntry();
      isTracking = currentEntry?.data?.description === issueDescription;
    } catch (error) {
      console.error(
        "Solidtime: Failed to refresh sidebar button state:",
        error,
      );
      return;
    }
  }

  styleGithubTimeTrackingButton(button, isTracking);
}

/**
 * Starts or stops a Solidtime time entry for the given issue description.
 * Shared by the sidebar Start/Stop button and the board card buttons -
 * throws on failure so each caller can render its own error UI.
 */
async function toggleGithubTimeEntry(
  issueDescription: string,
  isCurrentlyTracking: boolean,
): Promise<void> {
  if (!accessToken.value) {
    throw new Error("not_logged_in");
  }

  const client = apiClient();

  if (isCurrentlyTracking) {
    const currentEntry = await getCurrentTimeEntry();
    if (currentEntry?.data?.id) {
      await client.updateTimeEntry(
        {
          ...currentEntry.data,
          end: dayjs.utc().format(),
        },
        {
          params: {
            organization: currentEntry.data.organization_id,
            timeEntry: currentEntry.data.id,
          },
        },
      );
    }
    return;
  }

  const storage = await browser.storage.local.get([
    "current_organization_id",
    "currentMembershipId",
  ]);
  const organizationId = storage.current_organization_id as string | undefined;
  const membershipId = storage.currentMembershipId as string | undefined;

  if (!organizationId || !membershipId) {
    throw new Error("no_organization");
  }

  // Default to the project the user last tracked against instead of "No
  // Project" - starting a timer from a GitHub button carries no project context,
  // so reuse the most recent entry's project to match the popup's behaviour.
  const projectId = await getLastUsedProjectId(organizationId, membershipId);

  const timeEntryData: CreateTimeEntryBody = {
    member_id: membershipId,
    project_id: projectId,
    description: issueDescription,
    start: dayjs.utc().format(),
    billable: false,
  };

  await client.createTimeEntry(timeEntryData, {
    params: {
      organization: organizationId,
    },
  });
}

function alertGithubToggleError(error: unknown): void {
  if (error instanceof Error && error.message === "not_logged_in") {
    alert("Please log in to Solidtime first by clicking the extension icon");
    return;
  }
  if (error instanceof Error && error.message === "no_organization") {
    alert("Please select an organization in the Solidtime extension first");
    return;
  }
  alert("Failed to toggle time tracking. Please make sure you are logged in.");
}

/**
 * Handles the Start/Stop Tracking button click
 */
async function handleGithubTrackingClick(
  issueDescription: string,
  isCurrentlyTracking: boolean,
): Promise<void> {
  const button = document.getElementById(BUTTON_ID);
  if (!button) return;

  button.setAttribute("disabled", "true");
  button.style.opacity = "0.5";
  button.style.cursor = "not-allowed";

  try {
    await toggleGithubTimeEntry(issueDescription, isCurrentlyTracking);

    const sidebar = findGithubSidebar();
    if (sidebar) {
      await injectGithubTimeTrackingSection(sidebar, issueDescription, true);
    }
  } catch (error) {
    console.error("Failed to toggle time tracking:", error);
    alertGithubToggleError(error);
  } finally {
    if (button) {
      button.removeAttribute("disabled");
      button.style.opacity = "1";
      button.style.cursor = "pointer";
    }
  }
}

/**
 * Removes the Time Tracking section
 */
export function removeGithubTimeTrackingSection(): void {
  const section = document.getElementById(SECTION_ID);
  if (section) {
    section.remove();
  }
}

/**
 * Waits for an element to appear in the DOM
 */
export function waitForElement(
  selector: string | (() => HTMLElement | null),
  timeout = 5000,
): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      const element =
        typeof selector === "function"
          ? selector()
          : document.querySelector<HTMLElement>(selector);

      if (element) {
        resolve(element);
        return;
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error("Element not found within timeout"));
        return;
      }

      requestAnimationFrame(check);
    };

    check();
  });
}

/**
 * Watches for GitHub's Turbo navigation (github.com uses Turbo, not raw pushState)
 * to detect issue/PR changes without full page reloads.
 */
export function observeGithubNavigation(callback: () => void): void {
  document.addEventListener("turbo:load", callback);
  document.addEventListener("turbo:render", callback);
  // Fallback for any navigation Turbo doesn't intercept
  window.addEventListener("popstate", callback);
}

/**
 * Checks if the current page is a GitHub Projects v2 board (org or user project).
 */
export function isGithubProjectPage(): boolean {
  return /^\/(orgs|users)\/[^/]+\/projects\/\d+/.test(window.location.pathname);
}

/**
 * Finds the currently-open issue side panel on a Projects v2 board.
 * Clicking a board card opens this panel via a React Portal into
 * #__primerPortalRoot__ - it reuses the same IssueViewer component as the
 * standalone issue page, so all the sidebar/testid selectors above apply.
 */
export function findGithubProjectPanel(): HTMLElement | null {
  const portalRoot = document.getElementById("__primerPortalRoot__") || document;
  return portalRoot.querySelector<HTMLElement>(
    '[role="dialog"][aria-label^="Side panel: Issue"]',
  );
}

/**
 * Extracts issue info for the currently-open Projects v2 side panel from the
 * URL query params GitHub sets when a card is opened:
 * ?pane=issue&itemId=<id>&issue=<owner>|<repo>|<number>
 */
export function getGithubProjectPanelIssueInfo(): GithubIssueInfo | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("pane") !== "issue") {
    return null;
  }

  const issueParam = params.get("issue");
  if (!issueParam) {
    return null;
  }

  const [owner, repo, number] = issueParam.split("|");
  if (!owner || !repo || !number) {
    return null;
  }

  return {
    issueKey: `${owner}/${repo}#${number}`,
    owner,
    repo,
    number,
    fullUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
  };
}

/**
 * Watches for the Projects v2 side panel opening/closing.
 * Opening the panel is a React Portal mutation, not a Turbo navigation, so it
 * needs its own MutationObserver on the portal root rather than
 * observeGithubNavigation.
 */
export function observeGithubProjectPanel(callback: () => void): MutationObserver {
  const target = document.getElementById("__primerPortalRoot__") || document.body;
  const observer = new MutationObserver(callback);
  observer.observe(target, { childList: true, subtree: true });
  return observer;
}

const CARD_BUTTON_CLASS = "solidtime-github-card-btn";

/**
 * Parses a board card's issue info from its title link href, e.g.
 * https://github.com/owner/repo/issues/123. Reuses ISSUE_OR_PR_PATTERN so
 * card and standalone-page parsing stay in sync.
 */
function parseGithubCardIssueInfo(card: HTMLElement): GithubIssueInfo | null {
  const link = card.querySelector<HTMLAnchorElement>(
    'a[href*="/issues/"], a[href*="/pull/"]',
  );
  if (!link) {
    return null;
  }

  const match = new URL(link.href).pathname.match(ISSUE_OR_PR_PATTERN);
  if (!match) {
    return null;
  }

  const [, owner, repo, , number] = match;

  return {
    issueKey: `${owner}/${repo}#${number}`,
    owner,
    repo,
    number,
    fullUrl: link.href,
  };
}

function getGithubCardTitle(card: HTMLElement): string | null {
  const titleEl = card.querySelector('h3[id^="board-card-title-"]');
  return titleEl?.textContent?.trim() || null;
}

/**
 * Finds a board card's trailing header container (assignee avatars, kebab
 * neighbor) by walking up from the title element. GitHub doesn't give this
 * container a stable testid, so it's located structurally: the title lives
 * in the header's leading box, and the trailing box is that box's sibling.
 */
function findGithubBoardCardActionsContainer(card: HTMLElement): HTMLElement | null {
  const titleContainer = card.querySelector<HTMLElement>(
    '[id^="board-card-header-title-"]',
  );
  const headerLeadingBox = titleContainer?.parentElement;
  const headerRow = headerLeadingBox?.parentElement;
  if (!headerRow || !headerLeadingBox) {
    return null;
  }

  const trailingBox = Array.from(headerRow.children).find(
    (child) => child !== headerLeadingBox,
  ) as HTMLElement | undefined;

  return trailingBox || null;
}

function createGithubCardButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = CARD_BUTTON_CLASS;
  button.style.cssText =
    "display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; margin-left: 4px; border-radius: 6px; border: 1px solid var(--borderColor-default, #d0d7de); background: transparent; font-size: 11px; line-height: 1; cursor: pointer;";
  return button;
}

function updateGithubCardButtonState(
  button: HTMLButtonElement,
  isTracking: boolean,
): void {
  if (button.dataset.tracking === String(isTracking)) {
    return;
  }
  button.dataset.tracking = String(isTracking);
  button.textContent = isTracking ? "⏹" : "▶";
  button.title = isTracking ? "Stop timer" : "Start timer";
}

async function handleGithubCardButtonClick(
  button: HTMLButtonElement,
  issueDescription: string,
): Promise<void> {
  const isCurrentlyTracking = button.dataset.tracking === "true";

  button.setAttribute("disabled", "true");
  button.style.opacity = "0.5";

  try {
    await toggleGithubTimeEntry(issueDescription, isCurrentlyTracking);
    // Just changed server state - bypass the cache so buttons reflect it now.
    await refreshGithubBoardCardButtons(true);
  } catch (error) {
    console.error(
      "Solidtime: Failed to toggle time tracking from board card:",
      error,
    );
    alertGithubToggleError(error);
  } finally {
    button.removeAttribute("disabled");
    button.style.opacity = "1";
  }
}

// Cache the current-entry lookup so a burst of board mutations (virtualization,
// hover, drag reorders) doesn't fire one getCurrentTimeEntry request per
// animation frame. forceFresh bypasses it after a toggle or on tab focus, where
// up-to-date tracking state matters.
let boardEntryCache: { description: string | null; at: number } | null = null;
const BOARD_ENTRY_CACHE_MS = 5000;

async function getBoardCurrentEntryDescription(
  forceFresh: boolean,
): Promise<string | null> {
  if (
    !forceFresh &&
    boardEntryCache &&
    Date.now() - boardEntryCache.at < BOARD_ENTRY_CACHE_MS
  ) {
    return boardEntryCache.description;
  }

  let description: string | null = null;
  if (accessToken.value) {
    try {
      const currentEntry = await getCurrentTimeEntry();
      description = currentEntry?.data?.description || null;
    } catch (error) {
      console.error(
        "Solidtime: Failed to get current time entry for board cards:",
        error,
      );
      // Keep serving the last known value rather than flapping buttons to idle.
      return boardEntryCache?.description ?? null;
    }
  }

  boardEntryCache = { description, at: Date.now() };
  return description;
}

/**
 * Injects a compact Start/Stop button into every rendered board card and
 * syncs existing buttons' state against the current time entry. Board cards
 * are virtualized (GitHub only renders a card's header once it scrolls into
 * view), so this must be re-run on every board mutation, not just once.
 * The current-entry lookup is cached (see getBoardCurrentEntryDescription);
 * pass forceFresh after a toggle or on focus to bypass it.
 */
export async function refreshGithubBoardCardButtons(
  forceFresh = false,
): Promise<void> {
  const cards = document.querySelectorAll<HTMLElement>("[data-board-card-id]");
  if (cards.length === 0) {
    return;
  }

  const currentEntryDescription =
    await getBoardCurrentEntryDescription(forceFresh);

  cards.forEach((card) => {
    const issueInfo = parseGithubCardIssueInfo(card);
    if (!issueInfo) {
      return;
    }

    const issueTitle = getGithubCardTitle(card) || issueInfo.issueKey;
    const issueDescription = `${issueInfo.issueKey} ${issueTitle}`;
    const isTracking = currentEntryDescription === issueDescription;

    let button = card.querySelector<HTMLButtonElement>(`.${CARD_BUTTON_CLASS}`);

    if (!button) {
      const actionsContainer = findGithubBoardCardActionsContainer(card);
      if (!actionsContainer) {
        return;
      }

      button = createGithubCardButton();
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        handleGithubCardButtonClick(button as HTMLButtonElement, issueDescription);
      });
      actionsContainer.appendChild(button);
    }

    updateGithubCardButtonState(button, isTracking);
  });
}

/**
 * Watches the board for card renders (initial load, virtualization, view
 * switches) and keeps card buttons injected/in-sync. Runs on document.body
 * since Projects v2 view switches are React-driven, not Turbo navigations,
 * so a narrower board-container target could get silently detached.
 */
export function observeGithubBoardCards(): MutationObserver {
  let refreshScheduled = false;

  const scheduleRefresh = () => {
    if (refreshScheduled) {
      return;
    }
    refreshScheduled = true;
    requestAnimationFrame(() => {
      refreshScheduled = false;
      refreshGithubBoardCardButtons();
    });
  };

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, { childList: true, subtree: true });

  scheduleRefresh();

  return observer;
}

/**
 * Observes the DOM for changes and re-injects the section if it gets removed
 */
export function observeGithubSidebar(issueDescription: string): MutationObserver {
  let isReinjecting = false;
  let checkScheduled = false;

  const checkAndReinject = async () => {
    checkScheduled = false;

    if (isReinjecting) {
      return;
    }

    const sectionExists = document.getElementById(SECTION_ID);

    if (!sectionExists && isGithubIssuePage()) {
      isReinjecting = true;

      try {
        const sidebar = findGithubSidebar();
        if (sidebar) {
          await injectGithubTimeTrackingSection(sidebar, issueDescription);
        }
      } catch (error) {
        console.error("Solidtime: Failed to re-inject section:", error);
      } finally {
        setTimeout(() => {
          isReinjecting = false;
        }, 100);
      }
    }
  };

  const observer = new MutationObserver(() => {
    if (!checkScheduled) {
      checkScheduled = true;
      requestAnimationFrame(checkAndReinject);
    }
  });

  const mainContent =
    document.querySelector("#partial-discussion-sidebar") ||
    document.querySelector("main") ||
    document.body;

  observer.observe(mainContent, {
    childList: true,
    subtree: true,
  });

  return observer;
}
