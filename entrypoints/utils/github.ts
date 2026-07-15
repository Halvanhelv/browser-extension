/**
 * GitHub-specific utilities for detecting issue/PR pages and extracting issue information
 */

import { apiClient } from "./api";
import { getCurrentTimeEntry } from "./timeEntries";
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
 * Gets the issue/PR title from the DOM
 */
export function getIssueTitleFromDOM(): string | null {
  const titleElement =
    document.querySelector('[data-testid="issue-title"] bdi') ||
    document.querySelector('bdi.js-issue-title') ||
    document.querySelector("h1 bdi");

  if (titleElement) {
    return titleElement.textContent?.trim() || null;
  }

  return null;
}

/**
 * Finds the sidebar container where we should inject the Time Tracking section.
 * GitHub's issue/PR sidebar lists sections such as "Assignees", "Labels", "Projects" -
 * find one of those headings by text and walk up to the shared sidebar container,
 * mirroring the Linear integration's resilient (text-based, not class-based) lookup.
 */
export function findGithubSidebar(): HTMLElement | null {
  const headingTexts = ["Assignees", "Labels", "Projects", "Milestone"];

  const headings = Array.from(
    document.querySelectorAll("h3, [class*='sidebar-heading']"),
  ).filter((el) => headingTexts.includes(el.textContent?.trim() || ""));

  if (headings.length === 0) {
    return null;
  }

  const firstHeading = headings[0];
  let container = firstHeading.parentElement;

  for (let i = 0; i < 10 && container; i++) {
    const directChildren = Array.from(container.children);
    const sectionChildren = directChildren.filter((child) => {
      const text = child.textContent || "";
      return headingTexts.some((label) => text.includes(label));
    });

    if (sectionChildren.length >= 2) {
      return container as HTMLElement;
    }

    container = container.parentElement;
  }

  return null;
}

/**
 * Extracts classes from an existing sidebar section to match GitHub's styling
 */
function extractGithubClasses() {
  const headingTexts = ["Assignees", "Labels", "Projects", "Milestone"];
  const heading = Array.from(
    document.querySelectorAll("h3, [class*='sidebar-heading']"),
  ).find((el) => headingTexts.includes(el.textContent?.trim() || ""));

  if (!heading) {
    return { sectionClass: "", headingClass: "" };
  }

  const section = heading.parentElement;

  return {
    sectionClass: section?.className || "",
    headingClass: heading.className || "",
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

  const heading = document.createElement("h3");
  heading.className = classes.headingClass;
  heading.textContent = "Time Tracking";
  section.appendChild(heading);

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = isTracking ? "Stop Timer" : "Start Timer";
  button.style.cssText =
    "display: inline-flex; align-items: center; gap: 4px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--borderColor-default, #d0d7de); font-size: 12px; cursor: pointer; margin-top: 4px;";

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
      isTracking = currentEntry?.data?.id ? true : false;
    }
  } catch (error) {
    console.error("Failed to get current time entry:", error);
  }

  const section = createGithubTimeTrackingSection(
    issueDescription,
    isTracking,
  );
  sidebar.appendChild(section);

  const button = document.getElementById(BUTTON_ID);
  if (button) {
    button.addEventListener("click", () =>
      handleGithubTrackingClick(issueDescription, isTracking),
    );
  }
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
    if (!accessToken.value) {
      alert("Please log in to Solidtime first by clicking the extension icon");
      return;
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
    } else {
      const storage = await browser.storage.local.get([
        "current_organization_id",
        "currentMembershipId",
      ]);
      const organizationId = storage.current_organization_id;
      const membershipId = storage.currentMembershipId;

      if (!organizationId || !membershipId) {
        alert("Please select an organization in the Solidtime extension first");
        return;
      }

      const timeEntryData: CreateTimeEntryBody = {
        member_id: membershipId,
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

    const sidebar = findGithubSidebar();
    if (sidebar) {
      await injectGithubTimeTrackingSection(sidebar, issueDescription, true);
    }
  } catch (error) {
    console.error("Failed to toggle time tracking:", error);
    alert(
      "Failed to toggle time tracking. Please make sure you are logged in.",
    );
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
