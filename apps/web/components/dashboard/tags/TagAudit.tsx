"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanSearch } from "lucide-react";

import { useTRPC } from "@karakeep/shared-react/trpc";

type AuditCandidate = {
  intoTagId: string;
  intoTagName: string;
  fromTagId: string;
  fromTagName: string;
  reason: "same_spelling" | "synonym" | "similar_spelling";
  fromBookmarkCount: number;
  intoBookmarkCount: number;
  overlappingBookmarks: number;
  affectedBookmarks: number;
};

const explanations: Record<AuditCandidate["reason"], string> = {
  same_spelling: "Различия в регистре или разделителях",
  synonym: "Известные синонимы и аббревиатуры",
  similar_spelling: "Похожее написание — проверьте смысл",
};

export function TagAudit() {
  const api = useTRPC();
  const client = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<AuditCandidate | null>(null);
  const audit = useQuery(
    api.tags.auditDuplicates.queryOptions(undefined, { enabled: open }),
  );
  const { mutate: merge, isPending: merging } = useMutation(
    api.tags.merge.mutationOptions({
      onSuccess: () => {
        setSelected(null);
        toast({ description: "Теги объединены. Закладки сохранены." });
        void Promise.all([
          client.invalidateQueries(api.tags.auditDuplicates.pathFilter()),
          client.invalidateQueries(api.tags.list.pathFilter()),
          client.invalidateQueries(api.bookmarks.getBookmarks.pathFilter()),
        ]);
      },
      onError: (error) => {
        toast({
          description: error.message || "Не удалось объединить теги",
          variant: "destructive",
        });
      },
    }),
  );

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ScanSearch className="mr-2 size-4" />
        Аудит тегов
      </Button>
      {open && (
        <section
          className="mt-3 rounded-xl border p-4"
          aria-label="Аудит тегов"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Возможные дубли тегов</h2>
              <p className="text-sm text-muted-foreground">
                Предложения не изменяют данные. Каждое объединение требует
                подтверждения.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void audit.refetch()}
              disabled={audit.isFetching}
            >
              Обновить
            </Button>
          </div>
          {audit.isPending && <p>Анализ тегов…</p>}
          {audit.isError && (
            <p role="alert">Ошибка анализа: {audit.error.message}</p>
          )}
          {audit.data && (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                Проверено тегов: {audit.data.inspectedTags}. Предложений:{" "}
                {audit.data.suggestions.length}.
                {audit.data.truncated &&
                  " Показана частичная выборка: более 5000 тегов."}
              </p>
              {audit.data.suggestions.length === 0 ? (
                <p className="text-sm">
                  Очевидных дублей не обнаружено. Это не исключает смысловых
                  синонимов вне известного словаря.
                </p>
              ) : (
                <div className="max-h-[55vh] space-y-2 overflow-y-auto">
                  {audit.data.suggestions.map((item) => (
                    <div
                      key={item.fromTagId}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm">
                          <span className="font-medium">
                            {item.fromTagName}
                          </span>{" "}
                          →{" "}
                          <span className="font-medium">
                            {item.intoTagName}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {explanations[item.reason]}. Переносимых закладок:{" "}
                          {item.fromBookmarkCount}; после объединения у тега:{" "}
                          {item.affectedBookmarks}; общих:{" "}
                          {item.overlappingBookmarks}.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelected(item)}
                      >
                        Проверить
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(value) => {
          if (!value && !merging) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Подтвердить объединение тегов</DialogTitle>
            <DialogDescription>
              Проверьте, действительно ли эти теги означают одно и то же.
              Операцию нельзя автоматически отменить.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="space-y-2 text-sm">
              <p>
                Удалить тег: <strong>{selected.fromTagName}</strong>
              </p>
              <p>
                Сохранить тег: <strong>{selected.intoTagName}</strong>
              </p>
              <p>
                Закладок с исходным тегом:{" "}
                <strong>{selected.fromBookmarkCount}</strong>
              </p>
              <p>
                Уникальных закладок после объединения:{" "}
                <strong>{selected.affectedBookmarks}</strong>
              </p>
              <p className="text-muted-foreground">
                Закладки и их содержимое не удаляются. Удаляется только исходное
                имя тега, а его привязки переносятся на целевой тег.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={merging}
              onClick={() => setSelected(null)}
            >
              Отмена
            </Button>
            <Button
              disabled={!selected || merging}
              onClick={() => {
                if (!selected) return;
                merge({
                  intoTagId: selected.intoTagId,
                  fromTagIds: [selected.fromTagId],
                });
              }}
            >
              {merging ? "Объединение…" : "Подтвердить объединение"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
