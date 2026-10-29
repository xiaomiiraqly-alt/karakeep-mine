import { experimental_trpcMiddleware } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  zCreateTagRequestSchema,
  zGetTagResponseSchema,
  zTagBasicSchema,
  zTagListResponseSchema,
  zTagListValidatedRequestSchema,
  zUpdateTagRequestSchema,
} from "@karakeep/shared/types/tags";

import { addLogFields } from "@karakeep/shared-server";
import { bookmarkTags, tagsOnBookmarks } from "@karakeep/db/schema";
import { suggestTagMerges } from "@karakeep/shared/utils/tagAudit";

import type { AuthedContext } from "../index";
import {
  createEventLogMiddleware,
  createScopedAuthedProcedure,
  router,
} from "../index";
import { Tag } from "../models/tags";

const tagsProcedure = createScopedAuthedProcedure("tags");

export const ensureTagOwnership = experimental_trpcMiddleware<{
  ctx: AuthedContext;
  input: { tagId: string };
}>().create(async (opts) => {
  const tag = await Tag.fromId(opts.ctx, opts.input.tagId);
  return opts.next({
    ctx: {
      ...opts.ctx,
      tag,
    },
  });
});

export const tagsAppRouter = router({
  // Read-only preview. An explicit user action must call the existing tags.merge
  // mutation for each selected suggestion.
  auditDuplicates: tagsProcedure
    .output(
      z.object({
        inspectedTags: z.number(),
        truncated: z.boolean(),
        suggestions: z.array(
          z.object({
            fromTagId: z.string(),
            fromTagName: z.string(),
            intoTagId: z.string(),
            intoTagName: z.string(),
            reason: z.enum([
              "synonym",
              "same_spelling",
              "similar_spelling",
            ]),
            fromBookmarkCount: z.number(),
            intoBookmarkCount: z.number(),
            overlappingBookmarks: z.number(),
            affectedBookmarks: z.number(),
          }),
        ),
      }),
    )
    .query(async ({ ctx }) => {
      const tags = await ctx.db
        .select({
          id: bookmarkTags.id,
          name: bookmarkTags.name,
          usageCount: sql<number>`count(distinct ${tagsOnBookmarks.bookmarkId})`.mapWith(Number),
        })
        .from(bookmarkTags)
        .leftJoin(tagsOnBookmarks, eq(bookmarkTags.id, tagsOnBookmarks.tagId))
        .where(eq(bookmarkTags.userId, ctx.user.id))
        .groupBy(bookmarkTags.id)
        .limit(5001);

      const truncated = tags.length > 5000;
      const candidates = suggestTagMerges(tags.slice(0, 5000));
      const ids = [...new Set(candidates.flatMap((item) => [
        item.fromTagId,
        item.intoTagId,
      ]))];
      const attachments = ids.length
        ? await ctx.db
            .select({
              tagId: tagsOnBookmarks.tagId,
              bookmarkId: tagsOnBookmarks.bookmarkId,
            })
            .from(tagsOnBookmarks)
            .innerJoin(bookmarkTags, eq(bookmarkTags.id, tagsOnBookmarks.tagId))
            .where(
              and(
                eq(bookmarkTags.userId, ctx.user.id),
                inArray(tagsOnBookmarks.tagId, ids),
              ),
            )
        : [];
      const associated = new Map<string, Set<string>>();
      for (const row of attachments) {
        const set = associated.get(row.tagId) ?? new Set<string>();
        set.add(row.bookmarkId);
        associated.set(row.tagId, set);
      }
      return {
        inspectedTags: Math.min(tags.length, 5000),
        truncated,
        suggestions: candidates.map((item) => {
          const from = associated.get(item.fromTagId) ?? new Set<string>();
          const into = associated.get(item.intoTagId) ?? new Set<string>();
          const overlap = [...from].filter((id) => into.has(id)).length;
          return {
            ...item,
            overlappingBookmarks: overlap,
            affectedBookmarks: from.size + into.size - overlap,
          };
        }),
      };
    }),
  create: tagsProcedure
    .use(createEventLogMiddleware("tag.create"))
    .input(zCreateTagRequestSchema)
    .output(zTagBasicSchema)
    .mutation(async ({ input, ctx }) => {
      const tag = await Tag.create(ctx, input);
      addLogFields<"tag.create">({ "tag.id": tag.tag.id });
      return tag.asBasicTag();
    }),

  get: tagsProcedure
    .input(
      z.object({
        tagId: z.string(),
      }),
    )
    .output(zGetTagResponseSchema)
    .use(ensureTagOwnership)
    .query(async ({ ctx }) => {
      return await ctx.tag.getStats();
    }),
  delete: tagsProcedure
    .input(
      z.object({
        tagId: z.string(),
      }),
    )
    .use(ensureTagOwnership)
    .mutation(async ({ ctx }) => {
      await ctx.tag.delete();
    }),
  deleteUnused: tagsProcedure
    .output(
      z.object({
        deletedTags: z.number(),
      }),
    )
    .mutation(async ({ ctx }) => {
      const deletedCount = await Tag.deleteUnused(ctx);
      return { deletedTags: deletedCount };
    }),
  update: tagsProcedure
    .input(zUpdateTagRequestSchema)
    .output(zTagBasicSchema)
    .use(ensureTagOwnership)
    .mutation(async ({ input, ctx }) => {
      await ctx.tag.update(input);
      return ctx.tag.asBasicTag();
    }),
  merge: tagsProcedure
    .input(
      z.object({
        intoTagId: z.string(),
        fromTagIds: z.array(z.string()),
      }),
    )
    .output(
      z.object({
        mergedIntoTagId: z.string(),
        deletedTags: z.array(z.string()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return await Tag.merge(ctx, input);
    }),
  list: tagsProcedure
    .input(
      // TODO: Remove the optional and default once the next release is out.
      zTagListValidatedRequestSchema
        .optional()
        .default(zTagListValidatedRequestSchema.parse({})),
    )
    .output(zTagListResponseSchema)
    .query(async ({ ctx, input }) => {
      return await Tag.getAll(ctx, {
        nameContains: input.nameContains,
        ids: input.ids,
        attachedBy: input.attachedBy,
        sortBy: input.sortBy,
        pagination: input.limit
          ? {
              page: input.cursor?.page ?? 0,
              limit: input.limit,
            }
          : undefined,
      });
    }),
});
