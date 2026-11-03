import { t, useT } from "../i18n";
import { ALT_KEY, modKey } from "../lib/shortcut";
import { useAppStore } from "../store/useAppStore";

/** Put it in the function, and each render will get the text according to the current language */
function gestures(): Array<[string, string]> {
  return [
    [t("悬停"), t("节点放大并浮出预览卡片，高亮相连的边，无关节点淡出")],
    [t("单击"), t("选中并打开右侧详情，不改变图的结构")],
    [t("单击边"), t("看这条依赖由什么构成：引了哪些文件、用了哪些名字、有没有绕过包入口")],
    [t("双击"), t("就地展开子项；已展开则收起")],
    [t("{alt}双击", { alt: ALT_KEY }), t("以此节点为中心，只看它的邻居")],
    [t("右键"), t("聚焦、隐藏此枝、复制路径等高级操作")],
    [t("拖拽"), t("微调节点位置")],
    [t("滚轮"), t("缩放；缩得足够小时自动切换低细节渲染")],
    [modKey("K"), t("搜索文件、符号、包")],
    [modKey("I"), t("追问 AI：自动带上选中节点和当前视图；右键「加入 AI 对话」可再多带几个")],
    [t("划选"), t("在详情里选中一段文字或源码，点浮出的「追问」把它作为引用")],
    ["N", t("随手记一笔：记在选中的节点上，没选中就记在整个仓库上")],
    ["↑ ↓ → ←", t("单步走读时：上一步、下一步、步入被调函数、步出回到调用方")],
    ["Esc", t("逐层退回：收起对话 → 关抽屉 → 退出走读 → 取消选中 → 退出聚焦 → 恢复隐藏 → 收起全部")],
  ];
}

export function HelpSheet() {
  useT();
  const open = useAppStore((s) => s.helpOpen);
  const setOpen = useAppStore((s) => s.setHelpOpen);

  if (!open) return null;

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[520px] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center border-b border-[var(--color-line)] px-4 py-2.5">
          <span className="text-[13px] font-medium">{t("手势")}</span>
          <span className="ml-2 text-[10.5px] text-[var(--color-ink-faint)]">
            {t("在任何视图、任何节点类型上含义都相同")}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
          >
            ×
          </button>
        </div>

        <div className="p-4">
          <table className="w-full">
            <tbody>
              {gestures().map(([gesture, description]) => (
                <tr key={gesture} className="align-top">
                  <td className="whitespace-nowrap py-1 pr-4 text-[11.5px] text-[var(--color-accent)]">
                    {gesture}
                  </td>
                  <td className="py-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
                    {description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 border-t border-[var(--color-line)] pt-2.5 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
            {t("边的样式编码可信度：实线是解析器确定的依赖，虚线是名字匹配推断的，点线是有多个同名候选、默认不显示的。")}
            {t("最细的淡色点线是纯类型依赖（import type），只在编译期存在，不算运行时依赖。")}
            {t("标着 HTTP 的琥珀色虚线是前端请求按 URL 对上的后端路由，同样是推断出来的。")}
          </div>
          <div className="mt-2 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
            {t("顶栏的「视角」在节点底边叠一条细条：近 90 天改得勤不勤、测试走到了几成。")}
          </div>
        </div>
      </div>
    </div>
  );
}
