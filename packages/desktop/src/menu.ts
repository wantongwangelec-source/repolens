import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { tr } from "./locale.js";

export const HOMEPAGE = "https://github.com/wantongwangelec-source/repolens";

export interface MenuActions {
  addRepository: () => void;
  openSettings: () => void;
  checkForUpdates: () => void;
  openLogs: () => void;
}

/**
 * Application menu.
 *
 * There is no 'Edit' menu on macOS, and ⌘C / ⌘V in the input box does not work, so even the interface itself
 * Not needed, copying and pasting these items also requires them to be attached. Each label follows the interface language and does not rely on the system language;
 * After switching the interface language, it needs to be rebuilt once.
 */
export function buildMenu(actions: MenuActions): Menu {
  const isMac = process.platform === "darwin";
  const separator: MenuItemConstructorOptions = { type: "separator" };
  const settings: MenuItemConstructorOptions = {
    label: tr("设置…", "Settings…"),
    accelerator: "CmdOrCtrl+,",
    click: actions.openSettings,
  };
  const checkForUpdates: MenuItemConstructorOptions = {
    label: tr("检查更新…", "Check for Updates…"),
    click: actions.checkForUpdates,
  };
  const about: MenuItemConstructorOptions = { role: "about", label: tr(`关于 ${app.name}`, `About ${app.name}`) };

  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        about,
        checkForUpdates,
        separator,
        settings,
        separator,
        { role: "services", label: tr("服务", "Services") },
        separator,
        { role: "hide", label: tr(`隐藏 ${app.name}`, `Hide ${app.name}`) },
        { role: "hideOthers", label: tr("隐藏其他", "Hide Others") },
        { role: "unhide", label: tr("全部显示", "Show All") },
        separator,
        { role: "quit", label: tr(`退出 ${app.name}`, `Quit ${app.name}`) },
      ],
    });
  }

  template.push(
    {
      label: tr("文件", "File"),
      submenu: [
        { label: tr("添加仓库…", "Add Repository…"), accelerator: "CmdOrCtrl+O", click: actions.addRepository },
        ...(isMac ? [] : [separator, settings]),
        separator,
        isMac
          ? { role: "close", label: tr("关闭窗口", "Close Window") }
          : { role: "quit", label: tr("退出", "Exit") },
      ],
    },
    {
      label: tr("编辑", "Edit"),
      submenu: [
        { role: "undo", label: tr("撤销", "Undo") },
        { role: "redo", label: tr("重做", "Redo") },
        separator,
        { role: "cut", label: tr("剪切", "Cut") },
        { role: "copy", label: tr("复制", "Copy") },
        { role: "paste", label: tr("粘贴", "Paste") },
        { role: "selectAll", label: tr("全选", "Select All") },
      ],
    },
    {
      label: tr("视图", "View"),
      submenu: [
        { role: "reload", label: tr("重新加载", "Reload") },
        { role: "toggleDevTools", label: tr("开发者工具", "Developer Tools") },
        separator,
        { role: "resetZoom", label: tr("实际大小", "Actual Size") },
        { role: "zoomIn", label: tr("放大", "Zoom In") },
        { role: "zoomOut", label: tr("缩小", "Zoom Out") },
        separator,
        { role: "togglefullscreen", label: tr("全屏", "Toggle Full Screen") },
      ],
    },
    {
      label: tr("窗口", "Window"),
      submenu: [
        { role: "minimize", label: tr("最小化", "Minimize") },
        { role: "zoom", label: tr("缩放", "Zoom") },
        ...(isMac
          ? [separator, { role: "front", label: tr("前置全部窗口", "Bring All to Front") } as MenuItemConstructorOptions]
          : [{ role: "close", label: tr("关闭", "Close") } as MenuItemConstructorOptions]),
      ],
    },
    {
      role: "help",
      label: tr("帮助", "Help"),
      submenu: [
        { label: tr("项目主页", "Project Homepage"), click: () => void shell.openExternal(HOMEPAGE) },
        { label: tr("反馈问题", "Report an Issue"), click: () => void shell.openExternal(`${HOMEPAGE}/issues`) },
        { label: tr("打开日志文件夹", "Open Logs Folder"), click: actions.openLogs },
        ...(isMac ? [] : [separator, checkForUpdates, about]),
      ],
    },
  );

  return Menu.buildFromTemplate(template);
}
