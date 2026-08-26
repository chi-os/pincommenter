import express from 'express';
import {
  createServer,
  getServerPort,
  context,
  reddit,
  redis,
  scheduler,
  settings,
} from '@devvit/web/server';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import type {
  OnPostSubmitRequest,
  OnPostFlairUpdateRequest,
  TriggerResponse,
} from '@devvit/web/shared';

type T1 = `t1_${string}`;
type T3 = `t3_${string}`;

type CommentModel = Awaited<ReturnType<typeof reddit.submitComment>>;

type CommentState =
  | { status: 'waiting'; jobId: string }
  | { status: 'posted'; commentIds: T1[] };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseRule = (
  rule: string
): { condition: string; commentText: string } | null => {
  let condition = '';
  let commentText = '';

  if (rule.includes('=>')) {
    const splitIndex = rule.indexOf('=>');
    condition = rule.substring(0, splitIndex).trim();
    commentText = rule.substring(splitIndex + 2).trim();
  } else if (rule.includes(':::')) {
    const splitIndex = rule.indexOf(':::');
    condition = rule.substring(0, splitIndex).trim();
    commentText = rule.substring(splitIndex + 3).trim();
  } else if (rule.includes('|')) {
    const splitIndex = rule.lastIndexOf('|');
    condition = rule.substring(0, splitIndex).trim();
    commentText = rule.substring(splitIndex + 1).trim();
  }

  if (!condition || !commentText) return null;
  return { condition, commentText };
};

const formatCommentText = (rawText: string, authorName: string): string => {
  return rawText
    .replace(/\{\{author\}\}/g, authorName)
    .replace(/\\n/g, '\n');
};

const isFlairExcluded = (
  flairText: string | undefined,
  excludedFlairsConfig: string
): boolean => {
  if (!flairText || !excludedFlairsConfig) return false;

  const normalizedFlair = flairText.trim().toLowerCase();
  const excludedList = excludedFlairsConfig
    .split(',')
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f.length > 0);

  return excludedList.includes(normalizedFlair);
};

const isUserModerator = async (
  subredditName: string,
  username: string
): Promise<boolean> => {
  try {
    const moderators = await reddit.getModerators({ subredditName }).all();
    return moderators.some(
      (m) => m.username.toLowerCase() === username.toLowerCase()
    );
  } catch (error) {
    console.error(`🛑 [AuthCheck] Fehler beim Prüfen der Moderatoren: ${String(error)}`);
    return false;
  }
};

const isUserApproved = async (
  subredditName: string,
  username: string
): Promise<boolean> => {
  try {
    const approvedUsers = await reddit.getApprovedUsers({ subredditName }).all();
    return approvedUsers.some(
      (u) => u.username.toLowerCase() === username.toLowerCase()
    );
  } catch (error) {
    console.error(`🛑 [AuthCheck] Fehler beim Prüfen der Approved Users: ${String(error)}`);
    return false;
  }
};

const app = express();
app.use(express.json());
const router = express.Router();

// ---------------------------------------------------------
// 1. TRIGGER: onPostSubmit
// ---------------------------------------------------------
router.post<string, never, TriggerResponse, OnPostSubmitRequest>(
  '/internal/triggers/on-post-submit',
  async (req, res) => {
    const post = req.body.post;

    if (!post || !context.subredditName) {
      console.log('🛑 [onPostSubmit] Kontext oder Post ist undefined.');
      res.json({ status: 'ignored' });
      return;
    }

    const postId = post.id as T3;
    const subredditName = context.subredditName;

    try {
      const fullPost = await reddit.getPostById(postId);
      if (!fullPost) {
        console.log(`🛑 [onPostSubmit] Post ${postId} nicht gefunden.`);
        res.json({ status: 'ignored' });
        return;
      }

      const authorName = fullPost.authorName ?? '';

      // Moderatoren-Check
      const ignoreModerators =
        ((await settings.get('ignoreModerators')) as boolean) ?? true;
      if (ignoreModerators && authorName) {
        const isMod = await isUserModerator(subredditName, authorName);
        if (isMod) {
          console.log(
            `⏭️ [onPostSubmit] Post ${postId} stammt von Moderator u/${authorName}. Überspringe.`
          );
          res.json({ status: 'ok' });
          return;
        }
      }

      // Approved Members Check
      const ignoreApprovedUsers =
        ((await settings.get('ignoreApprovedUsers')) as boolean) ?? false;
      if (ignoreApprovedUsers && authorName) {
        const isApproved = await isUserApproved(subredditName, authorName);
        if (isApproved) {
          console.log(
            `⏭️ [onPostSubmit] Post ${postId} stammt von Approved Member u/${authorName}. Überspringe.`
          );
          res.json({ status: 'ok' });
          return;
        }
      }

      // Flair Blacklist Check (Case-Insensitive)
      const currentFlair = fullPost.flair?.text;
      const excludedFlairsConfig =
        ((await settings.get('excludedFlairs')) as string) ?? '';

      if (isFlairExcluded(currentFlair, excludedFlairsConfig)) {
        console.log(
          `⏭️ [onPostSubmit] Post ${postId} ignoriert (Flair-Ausschluss: "${currentFlair ?? ''}").`
        );
        res.json({ status: 'ok' });
        return;
      }

      // 1. Keyword-Auswertung
      const enableKeyword =
        ((await settings.get('enableKeyword')) as boolean) ?? false;
      const matchBehavior =
        ((await settings.get('matchBehavior')) as string) ?? 'keyword_only';
      const keywordRulesRaw =
        ((await settings.get('keywordRules')) as string) ?? '';

      const searchTarget = `${fullPost.title ?? ''} \n ${fullPost.body ?? ''}`;
      let matchedKeywordComment: string | null = null;

      if (enableKeyword && keywordRulesRaw) {
        const normalizedRules = keywordRulesRaw.includes(';;')
          ? keywordRulesRaw.split(';;')
          : keywordRulesRaw.split('\n');

        for (const rawRule of normalizedRules) {
          const parsed = parseRule(rawRule.trim());
          if (!parsed) continue;

          const { condition, commentText } = parsed;

          if (condition.startsWith('regex:')) {
            const pattern = condition.substring(6).trim();
            try {
              const regex = new RegExp(pattern, 'i');
              if (regex.test(searchTarget)) {
                matchedKeywordComment = commentText;
                break;
              }
            } catch (error) {
              console.log(
                `🛑 [onPostSubmit] Ungültiges Regex-Muster "${pattern}": ${String(error)}`
              );
            }
          } else {
            const keyword = condition.toLowerCase();
            if (searchTarget.toLowerCase().includes(keyword)) {
              matchedKeywordComment = commentText;
              break;
            }
          }
        }
      }

      // 2. Standard-Kommentar
      const enableStandard =
        ((await settings.get('enableStandard')) as boolean) ?? true;
      let standardCommentText: string | null = null;

      if (enableStandard) {
        const rawStandard =
          ((await settings.get('standardComment')) as string) ?? '';
        standardCommentText =
          rawStandard.trim().length > 0 ? rawStandard.trim() : null;
      }

      // 3. Finale Kommentar-Liste bestimmen
      const commentsToPost: string[] = [];

      if (matchedKeywordComment) {
        console.log(`💬 [onPostSubmit] Keyword-Treffer für Post ${postId} gefunden.`);
        if (matchBehavior === 'both' && standardCommentText) {
          commentsToPost.push(standardCommentText);
        }
        commentsToPost.push(matchedKeywordComment);
      } else if (standardCommentText) {
        commentsToPost.push(standardCommentText);
      }

      if (commentsToPost.length === 0) {
        console.log(`⏭️ [onPostSubmit] Keine Kommentare für ${postId} geplant.`);
        res.json({ status: 'ok' });
        return;
      }

      const displayAuthor = authorName || 'Redditor';
      const preparedTexts = commentsToPost.map((text) =>
        formatCommentText(text, displayAuthor)
      );

      const redisKey = `state_${postId}`;
      const existingState = await redis.get(redisKey);
      if (existingState) {
        console.log(`⏭️ [onPostSubmit] Post ${postId} wird bereits bearbeitet.`);
        res.json({ status: 'ok' });
        return;
      }

      const rawWaitTime = await settings.get('waitTimeSeconds');
      const parsedWaitTime = Number(rawWaitTime);
      const waitTimeSeconds =
        !isNaN(parsedWaitTime) && parsedWaitTime > 0 ? parsedWaitTime : 60;

      const runAtDate = new Date(Date.now() + waitTimeSeconds * 1000);

      const jobId = await scheduler.runJob({
        name: 'postCommentJob',
        data: { postId: postId, texts: preparedTexts },
        runAt: runAtDate,
      });

      const state: CommentState = { status: 'waiting', jobId: jobId };
      await redis.set(redisKey, JSON.stringify(state), {
        expiration: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      console.log(
        `⏰ [onPostSubmit] Timer für ${postId} in ${waitTimeSeconds} Sekunden gestartet (JobID: ${jobId}).`
      );
    } catch (error) {
      console.error(`🛑 [onPostSubmit] Kritischer Fehler: ${String(error)}`);
    }

    res.json({ status: 'ok' });
  }
);

// ---------------------------------------------------------
// 2. SCHEDULER: postCommentJob, Sticky & Lock
// ---------------------------------------------------------
router.post<
  string,
  never,
  TaskResponse,
  TaskRequest<{ postId: T3; texts: string[] }>
>('/internal/scheduler/post-comment-job', async (req, res) => {
  const postId = req.body.data?.postId;
  const textsToPost = req.body.data?.texts ?? [];

  if (!postId || !context.subredditName) {
    console.log('🛑 [postCommentJob] Fehlende PostID oder Subreddit-Kontext.');
    res.json({ status: 'error', message: 'Missing context/data' });
    return;
  }

  const redisKey = `state_${postId}`;

  try {
    const fullPost = await reddit.getPostById(postId);
    if (!fullPost) {
      console.log(`🛑 [postCommentJob] Post ${postId} existiert nicht mehr.`);
      await redis.del(redisKey);
      res.json({ status: 'ok' });
      return;
    }

    // Flair Check vor dem Posten
    const currentFlair = fullPost.flair?.text;
    const excludedFlairsConfig =
      ((await settings.get('excludedFlairs')) as string) ?? '';

    if (isFlairExcluded(currentFlair, excludedFlairsConfig)) {
      console.log(
        `⏭️ [postCommentJob] Post ${postId} Flair wurde nachträglich auf "${currentFlair ?? ''}" geändert. Abbruch.`
      );
      await redis.del(redisKey);
      res.json({ status: 'ok' });
      return;
    }

    const pinComment = ((await settings.get('pinComment')) as boolean) ?? true;
    const lockComment = ((await settings.get('lockComment')) as boolean) ?? false;
    const postedCommentIds: T1[] = [];

    for (let i = 0; i < textsToPost.length; i++) {
      const text = textsToPost[i];
      if (!text) continue;

      let commentInstance: CommentModel | null = null;
      let commentId: T1 | null = null;

      try {
        commentInstance = await reddit.submitComment({ id: postId, text: text });
        commentId = commentInstance.id as T1;
      } catch (error) {
        if (String(error).includes('RatelimitError')) {
          console.log('⏳ [postCommentJob] Rate Limit erreicht! Pausiere für 6 Sekunden...');
          await sleep(6000);
          try {
            commentInstance = await reddit.submitComment({
              id: postId,
              text: text,
            });
            commentId = commentInstance.id as T1;
          } catch (retryError) {
            console.error(
              `🛑 [postCommentJob] Retry fehlgeschlagen: ${String(retryError)}`
            );
          }
        } else {
          console.error(`🛑 [postCommentJob] Fehler beim Posten des Kommentars: ${String(error)}`);
        }
      }

      if (commentId && commentInstance) {
        postedCommentIds.push(commentId);
        console.log(`💬 [postCommentJob] Kommentar ${commentId} auf ${postId} gepostet.`);

        // Kommentar anpinnen (distinguish & sticky)
        if (pinComment) {
          try {
            await commentInstance.distinguish(true);
            console.log(`📌 [postCommentJob] Kommentar ${commentId} erfolgreich als Sticky angepinnt.`);
          } catch (pinErr) {
            console.error(`🛑 [postCommentJob] Fehler beim Pinnen des Kommentars ${commentId}: ${String(pinErr)}`);
          }
        }

        // Kommentar sperren (lock)
        if (lockComment) {
          try {
            await commentInstance.lock();
            console.log(`🔒 [postCommentJob] Kommentar ${commentId} erfolgreich gesperrt (Locked).`);
          } catch (lockErr) {
            console.error(`🛑 [postCommentJob] Fehler beim Sperren des Kommentars ${commentId}: ${String(lockErr)}`);
          }
        }
      }

      if (i < textsToPost.length - 1) {
        await sleep(2500);
      }
    }

    if (postedCommentIds.length > 0) {
      const newState: CommentState = {
        status: 'posted',
        commentIds: postedCommentIds,
      };
      await redis.set(redisKey, JSON.stringify(newState), {
        expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      console.log(`💬 [postCommentJob] Status für ${postedCommentIds.length} Kommentar(e) in Redis gesichert.`);
    } else {
      await redis.del(redisKey);
    }
  } catch (error) {
    console.error(`🛑 [postCommentJob] Kritischer Fehler im Scheduler: ${String(error)}`);
  }

  res.json({ status: 'ok' });
});

// ---------------------------------------------------------
// 3. TRIGGER: onPostFlairUpdate
// ---------------------------------------------------------
router.post<string, never, TriggerResponse, OnPostFlairUpdateRequest>(
  '/internal/triggers/on-post-flair-update',
  async (req, res) => {
    const post = req.body.post;

    if (!post || !context.subredditName) {
      res.json({ status: 'ignored' });
      return;
    }

    const postId = post.id as T3;
    const redisKey = `state_${postId}`;

    try {
      const fullPost = await reddit.getPostById(postId);
      if (!fullPost) {
        res.json({ status: 'ignored' });
        return;
      }

      const newFlair = fullPost.flair?.text;
      const excludedFlairsConfig =
        ((await settings.get('excludedFlairs')) as string) ?? '';

      if (isFlairExcluded(newFlair, excludedFlairsConfig)) {
        const existingStateRaw = await redis.get(redisKey);
        if (!existingStateRaw) {
          res.json({ status: 'ok' });
          return;
        }

        const state = JSON.parse(existingStateRaw) as CommentState;

        if (state.status === 'waiting') {
          await scheduler.cancelJob(state.jobId);
          console.log(
            `🗑️ [onPostFlairUpdate] Timer ${state.jobId} für ${postId} abgebrochen (Flair-Ausschluss: "${newFlair ?? ''}").`
          );
        } else if (state.status === 'posted') {
          for (const commentId of state.commentIds) {
            await reddit.remove(commentId, false);
            console.log(
              `🗑️ [onPostFlairUpdate] Kommentar ${commentId} auf ${postId} gelöscht (Flair-Ausschluss: "${newFlair ?? ''}").`
            );
          }
        }

        await redis.del(redisKey);
        console.log(`🗑️ [onPostFlairUpdate] Redis-Status für ${postId} bereinigt.`);
      }
    } catch (error) {
      console.error(`🛑 [onPostFlairUpdate] Fehler beim Aufräumen: ${String(error)}`);
    }

    res.json({ status: 'ok' });
  }
);

app.use(router);
const server = createServer(app);
server.on('error', (err: Error) =>
  console.error(`🛑 [Server] Fehler: ${err.stack ?? err.message}`)
);
server.listen(getServerPort());

export default app;