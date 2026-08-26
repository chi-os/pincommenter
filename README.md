# Pin Commenter (pincommenter) v0.1.0

A flexible, automated moderation bot built on the Devvit Web platform. This app delivers targeted, pinned top-level comments under new submissions based on customizable delays, strict keyword matching, and advanced regex rules.

## 💻 Source Code & Contributions

The source code for this project is fully open-source. You can view the code, report issues, or contribute directly on GitHub:
**[chi-os/pincommenter](https://www.google.com/search?q=https://github.com/chi-os/pincommenter)** The complete programm logic as a  graph can be found at github [here](https://github.com/chi-os/pincommenter/blob/main/logicgraph.html)

---

## How It Works

The app operates through an automated trigger-and-scheduler pipeline backed by a stateless Redis architecture:

1. **Phase 1: Ingestion & Exception Filtering**
The moment a post is submitted, the bot verifies author permissions and post metadata. Posts submitted by moderators, approved members, or assigned blacklisted flairs (case-insensitive) can be immediately ignored, if wanted.
2. **Phase 2: Rule Evaluation**
The post's title and body are parsed against your configured rules:
* **Keyword & Regex Rules:** Supports exact phrases or full regular expressions (e.g., `regex:\b(bug|issue)\b => Custom reply`).
* **Match Behavior Strategy:** Choose whether a keyword match should post **only** the specialized comment or dispatch **both** the standard message and the keyword response sequentially.
3. **Phase 3: Scheduler & Pinned Comment**
If conditions are met, a scheduled job is registered to execute after an exact delay in seconds. When the timer elapses:
* The bot verifies post existence and flair validity one final time.
* Comments are submitted with built-in API rate-limit protection.
* If enabled, comments are automatically stickied to the top of the thread.
4. **Lifecycle Watchdog:**
If a post's flair is retroactively changed to an excluded flair:
* Any pending timer is cancelled immediately.
* Any previously published bot comments on that post are automatically removed.



---

## Key Features

* **📌 Auto-Sticky** Automatically pins generated comments to ensure immediate visibility for thread participants.
* **⚡ Precision Delay Engine:** Configure delay timers to let discussions settle before posting if wanted.
* **🔍 Regex & Exact Keyword Matching:** Define granular rules with the `=>` delimiter to route specific topics to tailored guidance.
* **🛡️ Built-in Rate-Limit:** Handles Reddit API burst limitations gracefully with dynamic exponential pauses and retries.
* **🔀 Flexible Output Modes:** Control output cascade with `matchBehavior` (exclusive keyword response or combined standard + keyword replies).
* **🎛️ Case-Insensitive Flair Blacklist:** Exclude specific flairs from receiving automated comments at any stage of the post lifecycle.
* **👤 Dynamic Personalization:** Use the `{{author}}` placeholder in any comment string to address the creator directly.

---

## Configuration

Settings are fully integrated into Reddit's native Mod Tools (**Mod Tools -> Apps -> pincommenter**). The interface is structured into three distinct sections:

### 1. General Setup & Exceptions

* **Ignore Moderators:** Skip posts created by subreddit moderators.
* **Ignore Approved Users:** Skip posts submitted by approved community members.
* **Pin Bot Comment (Sticky):** Automatically sticky bot comments.
* **Ignored Post Flairs:** Comma-separated list of exact post flairs to ignore (case-insensitive).
* **Wait Time:** Exact delay before the scheduled comment is posted.

### 2. Standard Comment Setup

* **Enable Standard Comment:** Toggle the default community comment.
* **Standard Comment Text:** The fallback template (supports `{{author}}`).

### 3. Keyword Triggered Setup

* **Enable Keyword Comments:** Toggle topic-specific rule evaluation.
* **Keyword Rules:** Rule definitions separated by `;;` or line breaks using the format:
* `keyword => Your custom comment`
* `regex:\b(help|question)\b => Your regex-triggered comment`


* **Match Behavior:**
* `Only post keyword comment (Skip standard)`
* `Post both (Standard + Keyword comment)`


---

# Changelog

## 0.2.0

* Added sticky-option
* Added Linebreaks

## 0.1.0

* Initial release on the Devvit Web platform.
* Event-driven `onPostSubmit` and `onPostFlairUpdate` trigger pipeline.
* Precision timer execution via Devvit Scheduler with second-level accuracy.
* Support for regex and plain-text keyword matching using the `=>` rule delimiter.
* Sticky comment functionality.
* Case-insensitive flair exclusion and dynamic comment retraction upon flair update.
* Anti-spam rate-limit recovery mechanisms.