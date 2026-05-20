// ../bakin-bits-official/plugins/projects/client.tsx
import { registerPlugin } from "@makinbakin/sdk";
import { useRouter as useRouter3 } from "@makinbakin/sdk/hooks";
import { Suspense, useEffect as useEffect4 } from "react";

// ../bakin-bits-official/plugins/projects/components/project-grid.tsx
import { useState as useState2, useEffect as useEffect2, useCallback, useMemo } from "react";
import { useRouter } from "@makinbakin/sdk/hooks";
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/createLucideIcon.js
import { forwardRef as forwardRef2, createElement as createElement2 } from "react";

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/shared/src/utils/mergeClasses.js
var mergeClasses = (...classes) => classes.filter((className, index, array) => {
  return Boolean(className) && className.trim() !== "" && array.indexOf(className) === index;
}).join(" ").trim();

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/shared/src/utils/toKebabCase.js
var toKebabCase = (string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/shared/src/utils/toCamelCase.js
var toCamelCase = (string) => string.replace(/^([A-Z])|[\s-_]+(\w)/g, (match, p1, p2) => p2 ? p2.toUpperCase() : p1.toLowerCase());

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/shared/src/utils/toPascalCase.js
var toPascalCase = (string) => {
  const camelCase = toCamelCase(string);
  return camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
};

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/Icon.js
import { forwardRef, createElement } from "react";

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/defaultAttributes.js
var defaultAttributes = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/shared/src/utils/hasA11yProp.js
var hasA11yProp = (props) => {
  for (const prop in props) {
    if (prop.startsWith("aria-") || prop === "role" || prop === "title") {
      return true;
    }
  }
  return false;
};

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/Icon.js
var Icon = forwardRef(({
  color = "currentColor",
  size = 24,
  strokeWidth = 2,
  absoluteStrokeWidth,
  className = "",
  children,
  iconNode,
  ...rest
}, ref) => createElement("svg", {
  ref,
  ...defaultAttributes,
  width: size,
  height: size,
  stroke: color,
  strokeWidth: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth,
  className: mergeClasses("lucide", className),
  ...!children && !hasA11yProp(rest) && { "aria-hidden": "true" },
  ...rest
}, [
  ...iconNode.map(([tag, attrs]) => createElement(tag, attrs)),
  ...Array.isArray(children) ? children : [children]
]));

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/createLucideIcon.js
var createLucideIcon = (iconName, iconNode) => {
  const Component = forwardRef2(({ className, ...props }, ref) => createElement2(Icon, {
    ref,
    iconNode,
    className: mergeClasses(`lucide-${toKebabCase(toPascalCase(iconName))}`, `lucide-${iconName}`, className),
    ...props
  }));
  Component.displayName = toPascalCase(iconName);
  return Component;
};

// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/arrow-left.js
var __iconNode = [
  ["path", { d: "m12 19-7-7 7-7", key: "1l729n" }],
  ["path", { d: "M19 12H5", key: "x3x0zl" }]
];
var ArrowLeft = createLucideIcon("arrow-left", __iconNode);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/chevron-down.js
var __iconNode2 = [["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]];
var ChevronDown = createLucideIcon("chevron-down", __iconNode2);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/chevron-right.js
var __iconNode3 = [["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]];
var ChevronRight = createLucideIcon("chevron-right", __iconNode3);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/external-link.js
var __iconNode4 = [
  ["path", { d: "M15 3h6v6", key: "1q9fwt" }],
  ["path", { d: "M10 14 21 3", key: "gplh6r" }],
  ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", key: "a6xqqp" }]
];
var ExternalLink = createLucideIcon("external-link", __iconNode4);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/file-text.js
var __iconNode5 = [
  [
    "path",
    {
      d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
      key: "1oefj6"
    }
  ],
  ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" }],
  ["path", { d: "M10 9H8", key: "b1mrlr" }],
  ["path", { d: "M16 13H8", key: "t4e002" }],
  ["path", { d: "M16 17H8", key: "z1uh3a" }]
];
var FileText = createLucideIcon("file-text", __iconNode5);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/file.js
var __iconNode6 = [
  [
    "path",
    {
      d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
      key: "1oefj6"
    }
  ],
  ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" }]
];
var File = createLucideIcon("file", __iconNode6);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/film.js
var __iconNode7 = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
  ["path", { d: "M7 3v18", key: "bbkbws" }],
  ["path", { d: "M3 7.5h4", key: "zfgn84" }],
  ["path", { d: "M3 12h18", key: "1i2n21" }],
  ["path", { d: "M3 16.5h4", key: "1230mu" }],
  ["path", { d: "M17 3v18", key: "in4fa5" }],
  ["path", { d: "M17 7.5h4", key: "myr1c1" }],
  ["path", { d: "M17 16.5h4", key: "go4c1d" }]
];
var Film = createLucideIcon("film", __iconNode7);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/folder-kanban.js
var __iconNode8 = [
  [
    "path",
    {
      d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",
      key: "1fr9dc"
    }
  ],
  ["path", { d: "M8 10v4", key: "tgpxqk" }],
  ["path", { d: "M12 10v2", key: "hh53o1" }],
  ["path", { d: "M16 10v6", key: "1d6xys" }]
];
var FolderKanban = createLucideIcon("folder-kanban", __iconNode8);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/image.js
var __iconNode9 = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2", key: "1m3agn" }],
  ["circle", { cx: "9", cy: "9", r: "2", key: "af1f0g" }],
  ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21", key: "1xmnt7" }]
];
var Image = createLucideIcon("image", __iconNode9);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/link-2.js
var __iconNode10 = [
  ["path", { d: "M9 17H7A5 5 0 0 1 7 7h2", key: "8i5ue5" }],
  ["path", { d: "M15 7h2a5 5 0 1 1 0 10h-2", key: "1b9ql8" }],
  ["line", { x1: "8", x2: "16", y1: "12", y2: "12", key: "1jonct" }]
];
var Link2 = createLucideIcon("link-2", __iconNode10);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/list-filter.js
var __iconNode11 = [
  ["path", { d: "M2 5h20", key: "1fs1ex" }],
  ["path", { d: "M6 12h12", key: "8npq4p" }],
  ["path", { d: "M9 19h6", key: "456am0" }]
];
var ListFilter = createLucideIcon("list-filter", __iconNode11);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/music.js
var __iconNode12 = [
  ["path", { d: "M9 18V5l12-2v13", key: "1jmyc2" }],
  ["circle", { cx: "6", cy: "18", r: "3", key: "fqmcym" }],
  ["circle", { cx: "18", cy: "16", r: "3", key: "1hluhg" }]
];
var Music = createLucideIcon("music", __iconNode12);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/paperclip.js
var __iconNode13 = [
  [
    "path",
    {
      d: "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
      key: "1miecu"
    }
  ]
];
var Paperclip = createLucideIcon("paperclip", __iconNode13);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/pencil.js
var __iconNode14 = [
  [
    "path",
    {
      d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      key: "1a8usu"
    }
  ],
  ["path", { d: "m15 5 4 4", key: "1mk7zo" }]
];
var Pencil = createLucideIcon("pencil", __iconNode14);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/plus.js
var __iconNode15 = [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "M12 5v14", key: "s699le" }]
];
var Plus = createLucideIcon("plus", __iconNode15);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/search.js
var __iconNode16 = [
  ["path", { d: "m21 21-4.34-4.34", key: "14j7rj" }],
  ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }]
];
var Search = createLucideIcon("search", __iconNode16);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/trash-2.js
var __iconNode17 = [
  ["path", { d: "M10 11v6", key: "nco0om" }],
  ["path", { d: "M14 11v6", key: "outv1u" }],
  ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", key: "miytrc" }],
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", key: "e791ji" }]
];
var Trash2 = createLucideIcon("trash-2", __iconNode17);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/unlink.js
var __iconNode18 = [
  [
    "path",
    {
      d: "m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71",
      key: "yqzxt4"
    }
  ],
  [
    "path",
    {
      d: "m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71",
      key: "4qinb0"
    }
  ],
  ["line", { x1: "8", x2: "8", y1: "2", y2: "5", key: "1041cp" }],
  ["line", { x1: "2", x2: "5", y1: "8", y2: "8", key: "14m1p5" }],
  ["line", { x1: "16", x2: "16", y1: "19", y2: "22", key: "rzdirn" }],
  ["line", { x1: "19", x2: "22", y1: "16", y2: "16", key: "ox905f" }]
];
var Unlink = createLucideIcon("unlink", __iconNode18);
// ../bakin-bits-official/node_modules/.bun/lucide-react@0.577.0+3f10a4be4e334a9b/node_modules/lucide-react/dist/esm/icons/x.js
var __iconNode19 = [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
];
var X = createLucideIcon("x", __iconNode19);
// ../bakin-bits-official/plugins/projects/components/project-grid.tsx
import { Button as Button2 } from "@makinbakin/sdk/ui";
import { PluginHeader } from "@makinbakin/sdk/components";
import { EmptyState } from "@makinbakin/sdk/components";
import { Skeleton } from "@makinbakin/sdk/ui";
import { useQueryState } from "@makinbakin/sdk/hooks";
import { useSearch } from "@makinbakin/sdk/hooks";
import { useDebug } from "@makinbakin/sdk/hooks";

// ../bakin-bits-official/plugins/projects/components/project-status-badge.tsx
import { jsxDEV } from "react/jsx-dev-runtime";
"use client";
var STATUS_STYLES = {
  draft: { bg: "bg-zinc-500/20", text: "text-zinc-400", label: "Draft" },
  active: { bg: "bg-blue-500/20", text: "text-blue-400", label: "Active" },
  completed: { bg: "bg-emerald-500/20", text: "text-emerald-400", label: "Completed" },
  archived: { bg: "bg-zinc-600/20", text: "text-zinc-500", label: "Archived" }
};
function ProjectStatusBadge({ status, onClick }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.draft;
  return /* @__PURE__ */ jsxDEV("span", {
    className: `inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${style.bg} ${style.text} ${onClick ? "cursor-pointer hover:opacity-80" : ""}`,
    onClick,
    children: style.label
  }, undefined, false, undefined, this);
}

// ../bakin-bits-official/plugins/projects/components/project-card.tsx
import { jsxDEV as jsxDEV2 } from "react/jsx-dev-runtime";
"use client";
function ProgressBar({ value }) {
  return /* @__PURE__ */ jsxDEV2("div", {
    className: "h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden",
    children: /* @__PURE__ */ jsxDEV2("div", {
      className: "h-full rounded-full bg-blue-500 transition-all duration-300",
      style: { width: `${value}%` }
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime()))
    return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function ProjectCard({ project, onClick }) {
  return /* @__PURE__ */ jsxDEV2("button", {
    onClick,
    className: "text-left w-full rounded-lg border border-border bg-card p-4 hover:bg-[rgba(255,255,255,0.04)] transition-colors group",
    children: [
      /* @__PURE__ */ jsxDEV2("div", {
        className: "flex items-start justify-between gap-2 mb-3",
        children: [
          /* @__PURE__ */ jsxDEV2("h3", {
            className: "text-sm font-medium text-foreground group-hover:text-white line-clamp-2",
            children: project.title || "Untitled project"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV2(ProjectStatusBadge, {
            status: project.status
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ jsxDEV2(ProgressBar, {
        value: project.progress
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV2("div", {
        className: "flex items-center justify-between mt-3 text-[11px] text-muted-foreground",
        children: [
          /* @__PURE__ */ jsxDEV2("span", {
            children: [
              project.progress,
              "% complete"
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ jsxDEV2("span", {
            children: [
              project.taskCount,
              " items"
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ jsxDEV2("div", {
        className: "text-[11px] text-muted-foreground mt-1",
        children: [
          "Updated ",
          formatDate(project.updated)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// ../bakin-bits-official/plugins/projects/components/new-project-dialog.tsx
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input
} from "@makinbakin/sdk/ui";
import { jsxDEV as jsxDEV3 } from "react/jsx-dev-runtime";
"use client";
function NewProjectDialog({
  open,
  creating = false,
  error = null,
  onConfirm,
  onCancel
}) {
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (open)
      setTitle("");
  }, [open]);
  const trimmedTitle = title.trim();
  const handleSubmit = (event) => {
    event.preventDefault();
    if (!trimmedTitle || creating)
      return;
    onConfirm(trimmedTitle);
  };
  return /* @__PURE__ */ jsxDEV3(Dialog, {
    open,
    onOpenChange: (v) => {
      if (!v && !creating)
        onCancel();
    },
    children: /* @__PURE__ */ jsxDEV3(DialogContent, {
      className: "bg-card border-border max-w-sm",
      children: [
        /* @__PURE__ */ jsxDEV3(DialogHeader, {
          children: /* @__PURE__ */ jsxDEV3(DialogTitle, {
            children: "New project"
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV3("form", {
          className: "space-y-3",
          onSubmit: handleSubmit,
          children: [
            /* @__PURE__ */ jsxDEV3(Input, {
              value: title,
              onChange: (event) => setTitle(event.target.value),
              placeholder: "Project title...",
              autoFocus: true,
              disabled: creating
            }, undefined, false, undefined, this),
            error && /* @__PURE__ */ jsxDEV3("p", {
              className: "text-xs text-red-400",
              children: error
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV3("div", {
              className: "flex justify-end gap-2 mt-1",
              children: [
                /* @__PURE__ */ jsxDEV3(Button, {
                  type: "button",
                  variant: "outline",
                  onClick: onCancel,
                  disabled: creating,
                  children: "Cancel"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV3(Button, {
                  type: "submit",
                  disabled: !trimmedTitle || creating,
                  children: creating ? "Creating..." : "Create Project"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          ]
        }, undefined, true, undefined, this)
      ]
    }, undefined, true, undefined, this)
  }, undefined, false, undefined, this);
}

// ../bakin-bits-official/plugins/projects/components/project-grid.tsx
import { jsxDEV as jsxDEV4 } from "react/jsx-dev-runtime";
"use client";
var STATUS_TABS = [
  { label: "All", value: "all" },
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Completed", value: "completed" },
  { label: "Archived", value: "archived" }
];
function ProjectGrid() {
  const router = useRouter();
  const [projects, setProjects] = useState2([]);
  const [loading, setLoading] = useState2(true);
  const [newProjectOpen, setNewProjectOpen] = useState2(false);
  const [creatingProject, setCreatingProject] = useState2(false);
  const [createError, setCreateError] = useState2(null);
  const [status, setStatus] = useQueryState("status", "all");
  const [search, setSearch] = useQueryState("q", "");
  const [debug] = useDebug();
  const fetchProjects = useCallback(async () => {
    try {
      const url = status === "all" ? "/api/plugins/projects/" : `/api/plugins/projects/?status=${status}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects);
      }
    } finally {
      setLoading(false);
    }
  }, [status]);
  useEffect2(() => {
    fetchProjects();
  }, [fetchProjects]);
  const searchHook = useSearch({ plugin: "projects", facets: ["status"], debounce: 300 });
  useEffect2(() => {
    if (search)
      searchHook.search(search);
    else
      searchHook.clear();
  }, [search]);
  const scoreMap = useMemo(() => {
    const map = new Map;
    for (const r of searchHook.results) {
      map.set(r.id, { score: r.score, indexScores: r.indexScores });
    }
    return map;
  }, [searchHook.results]);
  const filtered = useMemo(() => {
    if (!search.trim())
      return projects;
    if (searchHook.results.length) {
      return projects.filter((p) => scoreMap.has(p.id)).sort((a, b) => (scoreMap.get(b.id)?.score ?? 0) - (scoreMap.get(a.id)?.score ?? 0));
    }
    const q = search.toLowerCase();
    return projects.filter((p) => p.title.toLowerCase().includes(q));
  }, [projects, search, searchHook.results, scoreMap]);
  const handleNew = () => {
    setCreateError(null);
    setNewProjectOpen(true);
  };
  const handleCreateProject = async (title) => {
    setCreatingProject(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/plugins/projects/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Failed to create project (${res.status})`);
      }
      const data = await res.json();
      if (typeof data.id !== "string" || !data.id) {
        throw new Error("Project create response did not include an id");
      }
      setNewProjectOpen(false);
      router.push(`/projects/${data.id}/edit`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingProject(false);
    }
  };
  return /* @__PURE__ */ jsxDEV4("div", {
    className: "p-6 flex flex-col h-full min-h-0 gap-4",
    children: [
      /* @__PURE__ */ jsxDEV4(PluginHeader, {
        title: "Projects",
        count: loading ? undefined : filtered.length,
        search: { value: search, onChange: setSearch, placeholder: "Search projects..." },
        actions: /* @__PURE__ */ jsxDEV4(Button2, {
          size: "sm",
          onClick: handleNew,
          children: [
            /* @__PURE__ */ jsxDEV4(Plus, {
              className: "size-4"
            }, undefined, false, undefined, this),
            "New Project"
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV4("div", {
        className: "flex items-center gap-3",
        children: [
          /* @__PURE__ */ jsxDEV4(ListFilter, {
            className: "size-3.5 text-muted-foreground shrink-0"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV4("div", {
            className: "flex items-center gap-0.5 bg-muted/50 rounded-lg p-0.5",
            children: STATUS_TABS.map((tab) => /* @__PURE__ */ jsxDEV4("button", {
              onClick: () => setStatus(tab.value),
              className: `px-2.5 py-1 rounded-md text-xs font-medium transition-all ${status === tab.value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`,
              children: tab.label
            }, tab.value, false, undefined, this))
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ jsxDEV4("div", {
        className: "flex-1 min-h-0 overflow-auto",
        children: loading ? /* @__PURE__ */ jsxDEV4("div", {
          className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4",
          children: Array.from({ length: 6 }).map((_, i) => /* @__PURE__ */ jsxDEV4(Skeleton, {
            className: "h-40 w-full"
          }, i, false, undefined, this))
        }, undefined, false, undefined, this) : filtered.length === 0 ? /* @__PURE__ */ jsxDEV4(EmptyState, {
          icon: FolderKanban,
          title: search ? "No matching projects" : status === "all" ? "No projects yet" : `No ${status} projects`,
          description: !search && status === "all" ? "Create one to get started." : undefined
        }, undefined, false, undefined, this) : /* @__PURE__ */ jsxDEV4("div", {
          className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4",
          children: filtered.map((p) => {
            const scoreInfo = scoreMap.get(p.id);
            const showScores = debug && scoreInfo && search.trim();
            const semKey = "embeddings";
            const bm25Key = scoreInfo?.indexScores ? Object.keys(scoreInfo.indexScores).find((k) => k !== semKey) : undefined;
            return /* @__PURE__ */ jsxDEV4("div", {
              className: "relative",
              children: [
                /* @__PURE__ */ jsxDEV4(ProjectCard, {
                  project: p,
                  onClick: () => router.push(`/projects/${p.id}`)
                }, undefined, false, undefined, this),
                showScores && scoreInfo && /* @__PURE__ */ jsxDEV4("div", {
                  className: "absolute top-1.5 left-1.5 flex flex-col gap-0.5 font-mono text-[10px] bg-black/80 px-1.5 py-1 rounded pointer-events-none",
                  children: [
                    /* @__PURE__ */ jsxDEV4("span", {
                      className: "text-amber-400",
                      children: [
                        "RRF ",
                        scoreInfo.score.toFixed(3)
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV4("span", {
                      className: "text-cyan-400",
                      children: [
                        "BM25 ",
                        (bm25Key ? scoreInfo.indexScores?.[bm25Key] ?? 0 : 0).toFixed(3)
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV4("span", {
                      className: "text-purple-400",
                      children: [
                        "SEM ",
                        (scoreInfo.indexScores?.[semKey] ?? 0).toFixed(3)
                      ]
                    }, undefined, true, undefined, this)
                  ]
                }, undefined, true, undefined, this)
              ]
            }, p.id, true, undefined, this);
          })
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV4(NewProjectDialog, {
        open: newProjectOpen,
        creating: creatingProject,
        error: createError,
        onConfirm: handleCreateProject,
        onCancel: () => {
          if (!creatingProject)
            setNewProjectOpen(false);
        }
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// ../bakin-bits-official/plugins/projects/components/project-detail.tsx
import { useState as useState4, useCallback as useCallback2, useRef, useEffect as useEffect3 } from "react";
import { useRouter as useRouter2 } from "@makinbakin/sdk/hooks";
import { useMainAgentId } from "@makinbakin/sdk/hooks";
import { AgentSelect, IntegratedBrainstorm, readBrainstormSseResponse } from "@makinbakin/sdk/components";
import { Slot } from "@makinbakin/sdk/slots";

// ../bakin-bits-official/plugins/projects/components/project-checklist.tsx
import { useState as useState3 } from "react";
import { jsxDEV as jsxDEV5 } from "react/jsx-dev-runtime";
"use client";
var COLUMN_COLORS = {
  backlog: "bg-zinc-500/20 text-zinc-400",
  todo: "bg-zinc-500/20 text-zinc-300",
  inProgress: "bg-blue-500/20 text-blue-400",
  review: "bg-amber-500/20 text-amber-400",
  done: "bg-emerald-500/20 text-emerald-400",
  archived: "bg-purple-500/20 text-purple-400",
  blocked: "bg-red-500/20 text-red-400"
};
function TaskItem({
  item,
  resolved,
  isStale,
  onToggle,
  onRemove,
  onPromote,
  onUpdate
}) {
  const [expanded, setExpanded] = useState3(false);
  const [editingDesc, setEditingDesc] = useState3(false);
  const [descDraft, setDescDraft] = useState3(item.description || "");
  const saveDesc = () => {
    onUpdate({ description: descDraft.trim() });
    setEditingDesc(false);
  };
  return /* @__PURE__ */ jsxDEV5("div", {
    className: "rounded-lg hover:bg-[rgba(255,255,255,0.02)] transition-colors",
    children: [
      /* @__PURE__ */ jsxDEV5("div", {
        className: "flex items-start gap-2 group py-1.5 px-1",
        children: [
          /* @__PURE__ */ jsxDEV5("button", {
            onClick: () => setExpanded(!expanded),
            className: "text-zinc-600 hover:text-zinc-400 transition-colors shrink-0 mt-0.5",
            children: /* @__PURE__ */ jsxDEV5(ChevronRight, {
              className: `size-3 transition-transform ${expanded ? "rotate-90" : ""}`
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV5("input", {
            type: "checkbox",
            checked: item.checked,
            onChange: (e) => onToggle(e.target.checked),
            className: "rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500/30 shrink-0 mt-0.5"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV5("span", {
            onClick: () => setExpanded(!expanded),
            className: `text-[11px] flex-1 cursor-pointer leading-snug ${item.checked ? "line-through text-zinc-600" : "text-foreground"}`,
            children: item.title
          }, undefined, false, undefined, this),
          item.taskId && resolved && /* @__PURE__ */ jsxDEV5("span", {
            className: `inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${COLUMN_COLORS[resolved.column] || "bg-zinc-500/20 text-zinc-400"}`,
            children: [
              /* @__PURE__ */ jsxDEV5(ExternalLink, {
                className: "size-2.5"
              }, undefined, false, undefined, this),
              item.taskId.slice(0, 6)
            ]
          }, undefined, true, undefined, this),
          isStale && /* @__PURE__ */ jsxDEV5("span", {
            className: "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400",
            children: [
              /* @__PURE__ */ jsxDEV5(Unlink, {
                className: "size-2.5"
              }, undefined, false, undefined, this),
              "missing"
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ jsxDEV5("div", {
            className: "flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity",
            children: [
              !item.taskId && !item.checked && /* @__PURE__ */ jsxDEV5("button", {
                onClick: onPromote,
                className: "p-1 rounded hover:bg-zinc-700 text-zinc-600 hover:text-foreground",
                title: "Create board task",
                children: /* @__PURE__ */ jsxDEV5(Link2, {
                  className: "size-3"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ jsxDEV5("button", {
                onClick: onRemove,
                className: "p-1 rounded hover:bg-zinc-700 text-zinc-600 hover:text-red-400",
                title: "Remove",
                children: /* @__PURE__ */ jsxDEV5(Trash2, {
                  className: "size-3"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      expanded && /* @__PURE__ */ jsxDEV5("div", {
        className: "pl-[42px] pr-1 pb-2",
        children: editingDesc ? /* @__PURE__ */ jsxDEV5("div", {
          className: "space-y-1.5",
          children: [
            /* @__PURE__ */ jsxDEV5("textarea", {
              value: descDraft,
              onChange: (e) => setDescDraft(e.target.value),
              placeholder: "Add details...",
              rows: 2,
              className: "w-full text-[11px] leading-relaxed bg-zinc-900/40 border border-[rgba(255,255,255,0.06)] rounded px-2.5 py-1.5 text-foreground placeholder:text-zinc-500 focus:outline-none focus:border-[#5e6ad2]/40 resize-y",
              autoFocus: true
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV5("div", {
              className: "flex gap-1.5",
              children: [
                /* @__PURE__ */ jsxDEV5("button", {
                  onClick: saveDesc,
                  className: "px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-300 hover:text-foreground border border-[rgba(255,255,255,0.06)] transition-colors",
                  children: "Save"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV5("button", {
                  onClick: () => {
                    setDescDraft(item.description || "");
                    setEditingDesc(false);
                  },
                  className: "px-2 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors",
                  children: "Cancel"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          ]
        }, undefined, true, undefined, this) : /* @__PURE__ */ jsxDEV5("button", {
          onClick: () => {
            setDescDraft(item.description || "");
            setEditingDesc(true);
          },
          className: "text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors w-full text-left",
          children: item.description || "Add details..."
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function ProjectChecklist({
  projectId,
  tasks,
  resolvedTasks,
  onToggle,
  onAdd,
  onRemove,
  onPromote
}) {
  const [newItemTitle, setNewItemTitle] = useState3("");
  const handleAdd = () => {
    if (!newItemTitle.trim())
      return;
    onAdd(newItemTitle.trim());
    setNewItemTitle("");
  };
  const handleUpdate = async (taskItemId, updates) => {
    await fetch(`/api/plugins/projects/${projectId}/checklist/${taskItemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates)
    });
  };
  return /* @__PURE__ */ jsxDEV5("div", {
    children: [
      /* @__PURE__ */ jsxDEV5("h3", {
        className: "text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3",
        children: "Tasks"
      }, undefined, false, undefined, this),
      tasks.length === 0 ? /* @__PURE__ */ jsxDEV5("p", {
        className: "text-[11px] text-zinc-600 mb-3",
        children: "No tasks yet."
      }, undefined, false, undefined, this) : /* @__PURE__ */ jsxDEV5("div", {
        className: "space-y-0.5 mb-3",
        children: tasks.map((item) => {
          const resolved = item.taskId ? resolvedTasks[item.taskId] : null;
          const stale = !!(item.taskId && resolvedTasks[item.taskId] === null);
          return /* @__PURE__ */ jsxDEV5(TaskItem, {
            item,
            resolved,
            isStale: stale,
            onToggle: (checked) => onToggle(item.id, checked),
            onRemove: () => onRemove(item.id),
            onPromote: () => onPromote(item.id),
            onUpdate: (updates) => handleUpdate(item.id, updates)
          }, item.id, false, undefined, this);
        })
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV5("div", {
        className: "flex gap-2",
        children: [
          /* @__PURE__ */ jsxDEV5("input", {
            type: "text",
            value: newItemTitle,
            onChange: (e) => setNewItemTitle(e.target.value),
            onKeyDown: (e) => e.key === "Enter" && handleAdd(),
            placeholder: "Add task...",
            className: "flex-1 text-[11px] bg-zinc-900/40 border border-[rgba(255,255,255,0.06)] rounded px-2.5 py-1.5 text-foreground placeholder:text-zinc-500 focus:outline-none focus:border-[#5e6ad2]/40 transition-colors"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV5("button", {
            onClick: handleAdd,
            disabled: !newItemTitle.trim(),
            className: "px-2 py-1.5 rounded bg-zinc-800 text-zinc-400 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors border border-[rgba(255,255,255,0.06)]",
            children: /* @__PURE__ */ jsxDEV5(Plus, {
              className: "size-3.5"
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// ../bakin-bits-official/plugins/projects/components/project-editor.tsx
import { MarkdownEditor } from "@makinbakin/sdk/components";
import { jsxDEV as jsxDEV6 } from "react/jsx-dev-runtime";
"use client";
function ProjectEditor({ body, editing, onChange }) {
  return /* @__PURE__ */ jsxDEV6(MarkdownEditor, {
    content: body,
    editing,
    onChange,
    placeholder: "Project details, goals, background...",
    format: "markdown"
  }, undefined, false, undefined, this);
}

// ../bakin-bits-official/plugins/projects/components/project-detail.tsx
import { Skeleton as Skeleton2 } from "@makinbakin/sdk/ui";
import { jsxDEV as jsxDEV7, Fragment } from "react/jsx-dev-runtime";
"use client";
var STATUS_CONFIG = {
  draft: { label: "Draft", dot: "bg-zinc-400" },
  active: { label: "Active", dot: "bg-[#5e6ad2]" },
  completed: { label: "Completed", dot: "bg-emerald-400" },
  archived: { label: "Archived", dot: "bg-zinc-600" }
};
var IMAGE_TYPES = new Set(["images", "image"]);
var ASSET_ICONS = {
  text: FileText,
  images: Image,
  video: Film,
  audio: Music
};
function AssetIcon({ type }) {
  const Icon2 = ASSET_ICONS[type] || File;
  return /* @__PURE__ */ jsxDEV7(Icon2, {
    className: "size-3.5 shrink-0 text-zinc-500"
  }, undefined, false, undefined, this);
}
function AssetThumb({ asset }) {
  const [err, setErr] = useState4(false);
  if (IMAGE_TYPES.has(asset.type) && !asset.missing && !err) {
    return /* @__PURE__ */ jsxDEV7("img", {
      src: `/api/assets/${encodeURIComponent(asset.filename)}`,
      alt: asset.filename,
      onError: () => setErr(true),
      className: "size-8 rounded object-cover shrink-0 bg-zinc-800"
    }, undefined, false, undefined, this);
  }
  return /* @__PURE__ */ jsxDEV7("div", {
    className: "size-8 rounded bg-zinc-800/60 flex items-center justify-center shrink-0",
    children: /* @__PURE__ */ jsxDEV7(AssetIcon, {
      type: asset.type
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function PickerThumb({ asset }) {
  const [err, setErr] = useState4(false);
  if (IMAGE_TYPES.has(asset.type) && !err) {
    return /* @__PURE__ */ jsxDEV7("img", {
      src: `/api/assets/${encodeURIComponent(asset.filename)}`,
      alt: asset.filename,
      onError: () => setErr(true),
      className: "size-7 rounded object-cover shrink-0 bg-zinc-800"
    }, undefined, false, undefined, this);
  }
  return /* @__PURE__ */ jsxDEV7("div", {
    className: "size-7 rounded bg-zinc-800/60 flex items-center justify-center shrink-0",
    children: /* @__PURE__ */ jsxDEV7(AssetIcon, {
      type: asset.type
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function ProjectDetail({ projectId, onBack, initialEdit = false, onEditChange }) {
  const router = useRouter2();
  const isNew = !projectId;
  const currentId = projectId || "";
  const mainAgentId = useMainAgentId() ?? "";
  const [project, setProject] = useState4(null);
  const [loading, setLoading] = useState4(!isNew);
  const [editing, setEditing] = useState4(false);
  const [editTitle, setEditTitle] = useState4("");
  const [editOwner, setEditOwner] = useState4("");
  const [editStatus, setEditStatus] = useState4("draft");
  const [editBody, setEditBody] = useState4("");
  const [brainstormAgent, setBrainstormAgent] = useState4(mainAgentId);
  const [brainstormMessages, setBrainstormMessages] = useState4([]);
  const [statusOpen, setStatusOpen] = useState4(false);
  const statusRef = useRef(null);
  const [assetPickerOpen, setAssetPickerOpen] = useState4(false);
  const [assetSearch, setAssetSearch] = useState4("");
  const [availableAssets, setAvailableAssets] = useState4([]);
  const [previewFilename, setPreviewFilename] = useState4(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState4(false);
  const [deleting, setDeleting] = useState4(false);
  const fetchProject = useCallback2(async (enterEdit2) => {
    if (!currentId)
      return;
    try {
      const res = await fetch(`/api/plugins/projects/${currentId}`);
      if (res.ok) {
        const data = await res.json();
        setProject(data.project);
        setEditTitle(data.project.title);
        setEditOwner(data.project.owner);
        setEditStatus(data.project.status);
        setEditBody(data.project.body);
        setBrainstormMessages(Array.isArray(data.project.brainstormMessages) ? data.project.brainstormMessages : []);
        const shouldEdit = enterEdit2 ?? false;
        setEditing(shouldEdit);
        onEditChange?.(shouldEdit);
      }
    } finally {
      setLoading(false);
    }
  }, [currentId, onEditChange]);
  useEffect3(() => {
    if (isNew) {
      router.replace("/projects", { scroll: false });
    } else {
      fetchProject(initialEdit);
    }
  }, []);
  useEffect3(() => {
    if (!mainAgentId)
      return;
    setBrainstormAgent((prev) => prev ? prev : mainAgentId);
    if (isNew) {
      setEditOwner((prev) => prev ? prev : mainAgentId);
      setProject((prev) => prev && !prev.owner ? { ...prev, owner: mainAgentId } : prev);
    }
  }, [mainAgentId, isNew]);
  useEffect3(() => {
    const handler = (e) => {
      if (statusRef.current && !statusRef.current.contains(e.target))
        setStatusOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const isDirty = project && (editTitle !== project.title || editOwner !== project.owner || editStatus !== project.status || editBody !== project.body);
  const saveField = async (field, value) => {
    if (isNew || !currentId)
      return;
    await fetch(`/api/plugins/projects/${currentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value })
    });
    fetchProject();
  };
  const enterEdit = () => {
    if (!project)
      return;
    setEditTitle(project.title);
    setEditBody(project.body);
    setEditing(true);
    onEditChange?.(true);
  };
  const cancelEdit = () => {
    if (!project)
      return;
    setEditTitle(project.title);
    setEditBody(project.body);
    setEditing(false);
    onEditChange?.(false);
  };
  const handleSave = async () => {
    if (!project || !isDirty || !currentId)
      return;
    const updates = { id: currentId };
    if (editTitle !== project.title)
      updates.title = editTitle;
    if (editOwner !== project.owner)
      updates.owner = editOwner;
    if (editStatus !== project.status)
      updates.status = editStatus;
    if (editBody !== project.body)
      updates.body = editBody;
    await fetch(`/api/plugins/projects/${currentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates)
    });
    fetchProject();
  };
  const toggleItem = async (taskItemId, checked) => {
    if (!currentId)
      return;
    await fetch(`/api/plugins/projects/${currentId}/checklist/${taskItemId}/toggle`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checked }) });
    fetchProject();
  };
  const addItem = async (title) => {
    if (!currentId)
      return;
    await fetch(`/api/plugins/projects/${currentId}/checklist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    fetchProject();
  };
  const removeItem = async (taskItemId) => {
    if (!currentId)
      return;
    await fetch(`/api/plugins/projects/${currentId}/checklist/${taskItemId}`, { method: "DELETE", headers: { "Content-Type": "application/json" } });
    fetchProject();
  };
  const promoteItem = async (taskItemId) => {
    if (!currentId)
      return;
    await fetch(`/api/plugins/projects/${currentId}/checklist/${taskItemId}/promote`, { method: "POST", headers: { "Content-Type": "application/json" } });
    fetchProject();
  };
  const projectAskOnSend = useCallback2(async (prompt, history, ctx) => {
    if (!currentId)
      throw new Error("Create the project before starting a brainstorm.");
    const res = await fetch(`/api/plugins/projects/${currentId}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctx.signal,
      body: JSON.stringify({
        projectId: currentId,
        prompt,
        agent: brainstormAgent,
        history: history.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content }))
      })
    });
    const result = await readBrainstormSseResponse(res, ctx);
    fetchProject();
    return result;
  }, [currentId, brainstormAgent, fetchProject]);
  const assetPickerRef = useRef(null);
  useEffect3(() => {
    if (!assetPickerOpen)
      return;
    const handler = (e) => {
      if (assetPickerRef.current && !assetPickerRef.current.contains(e.target)) {
        setAssetPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [assetPickerOpen]);
  const toggleAssetPicker = async () => {
    if (assetPickerOpen) {
      setAssetPickerOpen(false);
      return;
    }
    try {
      const res = await fetch("/api/plugins/assets/?grouped=false");
      if (res.ok) {
        const data = await res.json();
        const attached = new Set(project?.assets.map((a) => a.filename) || []);
        setAvailableAssets((data.assets || []).filter((a) => !attached.has(a.filename)).map((a) => ({
          filename: a.filename,
          type: a.type,
          description: a.metadata?.description
        })));
        setAssetSearch("");
        setAssetPickerOpen(true);
      }
    } catch {}
  };
  const handleAttachAsset = async (filename) => {
    if (!currentId)
      return;
    await fetch(`/api/plugins/projects/${currentId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename }) });
    setAssetPickerOpen(false);
    fetchProject();
  };
  const handleDetachAsset = async (filename) => {
    if (!currentId)
      return;
    await fetch(`/api/plugins/projects/${currentId}/assets/${encodeURIComponent(filename)}`, { method: "DELETE", headers: { "Content-Type": "application/json" } });
    fetchProject();
  };
  const filteredPickerAssets = availableAssets.filter((a) => {
    if (!assetSearch.trim())
      return true;
    const q = assetSearch.toLowerCase();
    return a.filename.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q);
  });
  const linkedTaskCount = project?.tasks.filter((t) => t.taskId).length ?? 0;
  const handleDelete = async (deleteLinkedTasks) => {
    if (!currentId)
      return;
    setDeleting(true);
    try {
      await fetch(`/api/plugins/projects/${currentId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteLinkedTasks })
      });
      onBack();
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };
  if (loading) {
    return /* @__PURE__ */ jsxDEV7("div", {
      className: "flex flex-col gap-3 py-4",
      children: [
        /* @__PURE__ */ jsxDEV7(Skeleton2, {
          className: "h-6 w-60"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV7(Skeleton2, {
          className: "h-4 w-40"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV7(Skeleton2, {
          className: "h-40 w-full"
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  if (!project)
    return /* @__PURE__ */ jsxDEV7("div", {
      className: "text-sm text-muted-foreground py-8",
      children: "Project not found."
    }, undefined, false, undefined, this);
  const statusCfg = STATUS_CONFIG[editStatus];
  return /* @__PURE__ */ jsxDEV7("div", {
    className: "flex flex-col h-full min-h-0",
    children: [
      /* @__PURE__ */ jsxDEV7("div", {
        className: "flex items-center justify-between pb-5 border-b border-[rgba(255,255,255,0.06)]",
        children: [
          /* @__PURE__ */ jsxDEV7("button", {
            onClick: onBack,
            className: "flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors",
            children: [
              /* @__PURE__ */ jsxDEV7(ArrowLeft, {
                className: "size-3.5"
              }, undefined, false, undefined, this),
              "Projects"
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ jsxDEV7("div", {
            className: "flex items-center gap-3",
            children: [
              /* @__PURE__ */ jsxDEV7("div", {
                ref: statusRef,
                className: "relative",
                children: [
                  /* @__PURE__ */ jsxDEV7("button", {
                    onClick: () => setStatusOpen(!statusOpen),
                    className: "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11px] font-medium text-zinc-300 bg-zinc-800/80 hover:bg-zinc-800 border border-[rgba(255,255,255,0.06)] transition-colors",
                    children: [
                      /* @__PURE__ */ jsxDEV7("span", {
                        className: `size-1.5 rounded-full ${statusCfg.dot}`
                      }, undefined, false, undefined, this),
                      statusCfg.label,
                      /* @__PURE__ */ jsxDEV7(ChevronDown, {
                        className: "size-2.5 text-zinc-500"
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this),
                  statusOpen && /* @__PURE__ */ jsxDEV7("div", {
                    className: "absolute top-full right-0 mt-1 w-36 bg-zinc-900 border border-[rgba(255,255,255,0.08)] rounded-lg shadow-xl z-30 py-1",
                    children: Object.entries(STATUS_CONFIG).map(([val, cfg]) => /* @__PURE__ */ jsxDEV7("button", {
                      onClick: () => {
                        setEditStatus(val);
                        setStatusOpen(false);
                        if (!editing)
                          saveField("status", val);
                      },
                      className: `w-full text-left px-3 py-1.5 text-[11px] flex items-center gap-2 transition-colors ${val === editStatus ? "text-foreground bg-zinc-800/60" : "text-zinc-400 hover:text-foreground hover:bg-zinc-800/40"}`,
                      children: [
                        /* @__PURE__ */ jsxDEV7("span", {
                          className: `size-1.5 rounded-full ${cfg.dot}`
                        }, undefined, false, undefined, this),
                        cfg.label
                      ]
                    }, val, true, undefined, this))
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ jsxDEV7(AgentSelect, {
                value: editOwner,
                onValueChange: (v) => {
                  setEditOwner(v);
                  if (!editing)
                    saveField("owner", v);
                },
                className: "h-7 w-auto min-w-[120px] text-[11px] bg-zinc-800/40 border-[rgba(255,255,255,0.04)]"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ jsxDEV7("span", {
                className: "w-px h-4 bg-[rgba(255,255,255,0.06)]"
              }, undefined, false, undefined, this),
              editing ? /* @__PURE__ */ jsxDEV7(Fragment, {
                children: [
                  /* @__PURE__ */ jsxDEV7("button", {
                    onClick: cancelEdit,
                    className: "h-7 px-3 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors",
                    children: "Cancel"
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ jsxDEV7("button", {
                    onClick: handleSave,
                    disabled: !isDirty,
                    className: `h-7 px-3 rounded-lg text-xs font-medium transition-all ${isDirty ? "bg-[#5e6ad2] text-white hover:bg-[#6e7ae2] shadow-sm shadow-[#5e6ad2]/20" : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}`,
                    children: "Save"
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this) : /* @__PURE__ */ jsxDEV7("button", {
                onClick: enterEdit,
                className: "inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800/60 hover:bg-zinc-800 border border-[rgba(255,255,255,0.06)] transition-colors",
                children: [
                  /* @__PURE__ */ jsxDEV7(Pencil, {
                    className: "size-3"
                  }, undefined, false, undefined, this),
                  "Edit"
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ jsxDEV7("span", {
                className: "w-px h-4 bg-[rgba(255,255,255,0.06)]"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ jsxDEV7("button", {
                onClick: () => setDeleteDialogOpen(true),
                className: "p-1 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors",
                title: "Delete project",
                children: /* @__PURE__ */ jsxDEV7(Trash2, {
                  className: "size-3.5"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      deleteDialogOpen && /* @__PURE__ */ jsxDEV7("div", {
        className: "fixed inset-0 z-50 flex items-center justify-center",
        children: [
          /* @__PURE__ */ jsxDEV7("div", {
            className: "absolute inset-0 bg-black/60",
            onClick: () => !deleting && setDeleteDialogOpen(false)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV7("div", {
            className: "relative bg-zinc-900 border border-[rgba(255,255,255,0.08)] rounded-xl shadow-2xl w-[420px] p-6",
            children: [
              /* @__PURE__ */ jsxDEV7("h3", {
                className: "text-sm font-semibold text-foreground mb-2",
                children: "Delete project?"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ jsxDEV7("p", {
                className: "text-[12px] text-zinc-400 mb-4",
                children: [
                  "This will permanently delete ",
                  /* @__PURE__ */ jsxDEV7("span", {
                    className: "text-zinc-200 font-medium",
                    children: project.title
                  }, undefined, false, undefined, this),
                  " and all its checklist items."
                ]
              }, undefined, true, undefined, this),
              linkedTaskCount > 0 && /* @__PURE__ */ jsxDEV7("div", {
                className: "mb-4 p-3 rounded-lg bg-zinc-800/60 border border-[rgba(255,255,255,0.06)]",
                children: [
                  /* @__PURE__ */ jsxDEV7("p", {
                    className: "text-[11px] text-zinc-300 mb-2",
                    children: [
                      "This project has ",
                      /* @__PURE__ */ jsxDEV7("span", {
                        className: "font-medium text-foreground",
                        children: linkedTaskCount
                      }, undefined, false, undefined, this),
                      " linked board ",
                      linkedTaskCount === 1 ? "task" : "tasks",
                      ". What should happen to ",
                      linkedTaskCount === 1 ? "it" : "them",
                      "?"
                    ]
                  }, undefined, true, undefined, this),
                  /* @__PURE__ */ jsxDEV7("div", {
                    className: "flex gap-2",
                    children: [
                      /* @__PURE__ */ jsxDEV7("button", {
                        onClick: () => handleDelete(false),
                        disabled: deleting,
                        className: "flex-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-700/60 text-zinc-300 hover:text-foreground hover:bg-zinc-700 border border-[rgba(255,255,255,0.06)] transition-colors disabled:opacity-50",
                        children: deleting ? "Deleting..." : "Keep tasks on board"
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV7("button", {
                        onClick: () => handleDelete(true),
                        disabled: deleting,
                        className: "flex-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors disabled:opacity-50",
                        children: deleting ? "Deleting..." : "Delete tasks too"
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ jsxDEV7("div", {
                className: "flex justify-end gap-2",
                children: [
                  /* @__PURE__ */ jsxDEV7("button", {
                    onClick: () => setDeleteDialogOpen(false),
                    disabled: deleting,
                    className: "px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50",
                    children: "Cancel"
                  }, undefined, false, undefined, this),
                  linkedTaskCount === 0 && /* @__PURE__ */ jsxDEV7("button", {
                    onClick: () => handleDelete(false),
                    disabled: deleting,
                    className: "px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors disabled:opacity-50",
                    children: deleting ? "Deleting..." : "Delete"
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ jsxDEV7("div", {
        className: "flex gap-6 pt-5 flex-1 min-h-0 overflow-hidden",
        children: [
          /* @__PURE__ */ jsxDEV7("div", {
            className: "flex-1 min-w-0 flex flex-col",
            children: [
              /* @__PURE__ */ jsxDEV7("div", {
                className: "flex-1 min-h-0 overflow-y-auto pr-1",
                style: { scrollbarGutter: "stable" },
                children: [
                  /* @__PURE__ */ jsxDEV7("label", {
                    className: "text-[10px] font-medium text-zinc-600 uppercase tracking-wider mb-1.5 block",
                    children: "Title"
                  }, undefined, false, undefined, this),
                  editing ? /* @__PURE__ */ jsxDEV7("input", {
                    type: "text",
                    value: editTitle,
                    onChange: (e) => setEditTitle(e.target.value),
                    className: "w-full text-xl font-semibold text-foreground bg-zinc-900/40 border border-[rgba(255,255,255,0.06)] rounded-lg outline-none px-4 py-2.5 placeholder:text-zinc-500 mb-5 tracking-tight focus:border-[#5e6ad2]/40 transition-colors",
                    placeholder: "Untitled project",
                    autoFocus: true
                  }, undefined, false, undefined, this) : /* @__PURE__ */ jsxDEV7("h1", {
                    className: "text-xl font-semibold text-foreground tracking-tight mb-5",
                    children: project.title || "Untitled project"
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ jsxDEV7("label", {
                    className: "text-[10px] font-medium text-zinc-600 uppercase tracking-wider mb-1.5 block",
                    children: "Details"
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ jsxDEV7("div", {
                    className: "mb-6",
                    children: /* @__PURE__ */ jsxDEV7(ProjectEditor, {
                      body: editBody,
                      editing,
                      onChange: setEditBody
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ jsxDEV7(IntegratedBrainstorm, {
                messages: brainstormMessages,
                onMessagesChange: setBrainstormMessages,
                onSend: projectAskOnSend,
                agentId: brainstormAgent,
                onAgentChange: setBrainstormAgent,
                placeholder: "Ask about this project..."
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ jsxDEV7("div", {
            className: "w-[346px] shrink-0 overflow-y-auto space-y-5 border-l border-[rgba(255,255,255,0.06)] pl-6 pr-2",
            style: { scrollbarGutter: "stable" },
            children: [
              /* @__PURE__ */ jsxDEV7("div", {
                children: [
                  /* @__PURE__ */ jsxDEV7("div", {
                    className: "flex items-center justify-between mb-2",
                    children: [
                      /* @__PURE__ */ jsxDEV7("h3", {
                        className: "text-xs font-medium text-zinc-500 uppercase tracking-wider",
                        children: "Progress"
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV7("span", {
                        className: "text-[11px] font-mono text-zinc-400 tabular-nums",
                        children: [
                          project.progress,
                          "%"
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this),
                  /* @__PURE__ */ jsxDEV7("div", {
                    className: "h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden",
                    children: /* @__PURE__ */ jsxDEV7("div", {
                      className: "h-full rounded-full bg-[#5e6ad2] transition-all duration-500",
                      style: { width: `${project.progress}%` }
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ jsxDEV7("div", {
                className: "pt-4 border-t border-[rgba(255,255,255,0.06)]",
                children: /* @__PURE__ */ jsxDEV7(ProjectChecklist, {
                  projectId: currentId,
                  tasks: project.tasks,
                  resolvedTasks: project.resolvedTasks,
                  onToggle: toggleItem,
                  onAdd: addItem,
                  onRemove: removeItem,
                  onPromote: promoteItem
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ jsxDEV7("div", {
                className: "pt-4 border-t border-[rgba(255,255,255,0.06)]",
                children: [
                  /* @__PURE__ */ jsxDEV7("div", {
                    className: "flex items-center justify-between mb-3",
                    children: [
                      /* @__PURE__ */ jsxDEV7("h3", {
                        className: "text-xs font-medium text-zinc-500 uppercase tracking-wider",
                        children: "Assets"
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV7("button", {
                        onClick: toggleAssetPicker,
                        className: "flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors",
                        children: [
                          /* @__PURE__ */ jsxDEV7(Paperclip, {
                            className: "size-3"
                          }, undefined, false, undefined, this),
                          "Attach"
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this),
                  project.resolvedAssets.length === 0 ? /* @__PURE__ */ jsxDEV7("p", {
                    className: "text-[11px] text-zinc-600",
                    children: "No assets attached."
                  }, undefined, false, undefined, this) : /* @__PURE__ */ jsxDEV7("div", {
                    className: "space-y-1.5",
                    children: project.resolvedAssets.map((asset) => /* @__PURE__ */ jsxDEV7("div", {
                      className: `group flex items-start gap-2.5 p-1.5 rounded-lg hover:bg-zinc-800/40 transition-colors ${asset.missing ? "opacity-40 pointer-events-none" : "cursor-pointer"}`,
                      onClick: () => !asset.missing && setPreviewFilename(asset.filename),
                      children: [
                        /* @__PURE__ */ jsxDEV7(AssetThumb, {
                          asset
                        }, undefined, false, undefined, this),
                        /* @__PURE__ */ jsxDEV7("div", {
                          className: "flex-1 min-w-0 pt-0.5",
                          children: [
                            /* @__PURE__ */ jsxDEV7("p", {
                              className: "text-[11px] text-zinc-300 truncate leading-tight",
                              children: asset.label || asset.filename
                            }, undefined, false, undefined, this),
                            asset.description && /* @__PURE__ */ jsxDEV7("p", {
                              className: "text-[10px] text-zinc-600 truncate mt-0.5",
                              children: asset.description
                            }, undefined, false, undefined, this),
                            asset.tags && asset.tags.length > 0 && /* @__PURE__ */ jsxDEV7("div", {
                              className: "flex gap-1 mt-1 flex-wrap",
                              children: asset.tags.slice(0, 3).map((tag) => /* @__PURE__ */ jsxDEV7("span", {
                                className: "text-[9px] px-1 py-0.5 rounded bg-zinc-800/60 text-zinc-500",
                                children: tag
                              }, tag, false, undefined, this))
                            }, undefined, false, undefined, this),
                            asset.missing && /* @__PURE__ */ jsxDEV7("span", {
                              className: "text-[10px] text-amber-500/70",
                              children: "missing"
                            }, undefined, false, undefined, this)
                          ]
                        }, undefined, true, undefined, this),
                        /* @__PURE__ */ jsxDEV7("button", {
                          onClick: (e) => {
                            e.stopPropagation();
                            handleDetachAsset(asset.filename);
                          },
                          className: "opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-all shrink-0 mt-1",
                          children: /* @__PURE__ */ jsxDEV7(X, {
                            className: "size-3"
                          }, undefined, false, undefined, this)
                        }, undefined, false, undefined, this)
                      ]
                    }, asset.filename, true, undefined, this))
                  }, undefined, false, undefined, this),
                  assetPickerOpen && /* @__PURE__ */ jsxDEV7("div", {
                    ref: assetPickerRef,
                    className: "mt-2 mr-2 border border-[rgba(255,255,255,0.08)] rounded-lg bg-zinc-900 overflow-hidden max-w-[310px]",
                    children: [
                      /* @__PURE__ */ jsxDEV7("div", {
                        className: "px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] flex items-center gap-1.5",
                        children: [
                          /* @__PURE__ */ jsxDEV7("div", {
                            className: "flex-1 flex items-center gap-1.5 bg-zinc-800 rounded px-2 py-1",
                            children: [
                              /* @__PURE__ */ jsxDEV7(Search, {
                                className: "size-3 text-zinc-500 shrink-0"
                              }, undefined, false, undefined, this),
                              /* @__PURE__ */ jsxDEV7("input", {
                                type: "text",
                                value: assetSearch,
                                onChange: (e) => setAssetSearch(e.target.value),
                                placeholder: "Search assets...",
                                className: "flex-1 text-[11px] bg-transparent text-foreground placeholder:text-zinc-500 focus:outline-none",
                                autoFocus: true
                              }, undefined, false, undefined, this),
                              assetSearch && /* @__PURE__ */ jsxDEV7("button", {
                                onClick: () => setAssetSearch(""),
                                className: "text-zinc-600 hover:text-zinc-400",
                                children: /* @__PURE__ */ jsxDEV7(X, {
                                  className: "size-2.5"
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this)
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV7("button", {
                            onClick: () => setAssetPickerOpen(false),
                            className: "text-zinc-500 hover:text-zinc-300 transition-colors shrink-0",
                            children: /* @__PURE__ */ jsxDEV7(X, {
                              className: "size-3.5"
                            }, undefined, false, undefined, this)
                          }, undefined, false, undefined, this)
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV7("div", {
                        className: "max-h-52 overflow-y-auto",
                        children: filteredPickerAssets.length === 0 ? /* @__PURE__ */ jsxDEV7("p", {
                          className: "text-[11px] text-zinc-600 p-3 text-center",
                          children: availableAssets.length === 0 ? "No assets available." : "No matches."
                        }, undefined, false, undefined, this) : filteredPickerAssets.map((asset) => /* @__PURE__ */ jsxDEV7("button", {
                          onClick: () => handleAttachAsset(asset.filename),
                          className: "w-full text-left px-2.5 py-2 text-[11px] hover:bg-zinc-800/60 transition-colors flex items-center gap-2.5 border-b border-[rgba(255,255,255,0.04)] last:border-0",
                          children: [
                            /* @__PURE__ */ jsxDEV7(PickerThumb, {
                              asset
                            }, undefined, false, undefined, this),
                            /* @__PURE__ */ jsxDEV7("div", {
                              className: "flex-1 min-w-0",
                              children: [
                                /* @__PURE__ */ jsxDEV7("span", {
                                  className: "text-zinc-300 truncate block",
                                  children: asset.filename
                                }, undefined, false, undefined, this),
                                asset.description && /* @__PURE__ */ jsxDEV7("span", {
                                  className: "text-zinc-600 truncate block text-[10px]",
                                  children: asset.description
                                }, undefined, false, undefined, this)
                              ]
                            }, undefined, true, undefined, this)
                          ]
                        }, asset.filename, true, undefined, this))
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ jsxDEV7("div", {
                className: "pt-4 border-t border-[rgba(255,255,255,0.06)]",
                children: [
                  /* @__PURE__ */ jsxDEV7("h3", {
                    className: "text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2",
                    children: "Details"
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ jsxDEV7("div", {
                    className: "space-y-1.5 text-[11px]",
                    children: [
                      /* @__PURE__ */ jsxDEV7("div", {
                        className: "flex justify-between",
                        children: [
                          /* @__PURE__ */ jsxDEV7("span", {
                            className: "text-zinc-600",
                            children: "Created"
                          }, undefined, false, undefined, this),
                          /* @__PURE__ */ jsxDEV7("span", {
                            className: "text-zinc-400",
                            children: new Date(project.updated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                          }, undefined, false, undefined, this)
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV7("div", {
                        className: "flex justify-between",
                        children: [
                          /* @__PURE__ */ jsxDEV7("span", {
                            className: "text-zinc-600",
                            children: "Updated"
                          }, undefined, false, undefined, this),
                          /* @__PURE__ */ jsxDEV7("span", {
                            className: "text-zinc-400",
                            children: new Date(project.updated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                          }, undefined, false, undefined, this)
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV7("div", {
                        className: "flex justify-between",
                        children: [
                          /* @__PURE__ */ jsxDEV7("span", {
                            className: "text-zinc-600",
                            children: "ID"
                          }, undefined, false, undefined, this),
                          /* @__PURE__ */ jsxDEV7("span", {
                            className: "text-zinc-500 font-mono",
                            children: project.id.slice(0, 8)
                          }, undefined, false, undefined, this)
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                ]
              }, undefined, true, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      previewFilename && /* @__PURE__ */ jsxDEV7(Slot, {
        name: "asset-detail-modal",
        filename: previewFilename,
        onClose: () => setPreviewFilename(null)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// ../bakin-bits-official/plugins/projects/client.tsx
import { jsxDEV as jsxDEV8 } from "react/jsx-dev-runtime";
var navItems = [
  { id: "projects", label: "Projects", icon: "Compass", href: "/projects", order: 30 }
];
function ProjectsPageFrame({ children, edge = false }) {
  return /* @__PURE__ */ jsxDEV8("div", {
    className: `${edge ? "p-[5px]" : "p-6"} flex flex-col h-full min-h-0 min-w-0 overflow-hidden`,
    children: /* @__PURE__ */ jsxDEV8(Suspense, {
      children
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function ProjectsIndexRoute() {
  return /* @__PURE__ */ jsxDEV8(ProjectsPageFrame, {
    edge: true,
    children: /* @__PURE__ */ jsxDEV8(ProjectGrid, {}, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function ProjectsNewRoute() {
  const router = useRouter3();
  useEffect4(() => {
    router.replace("/projects");
  }, [router]);
  return null;
}
function ProjectDetailRoute({ params, id }) {
  const router = useRouter3();
  const projectId = id ?? params?.id;
  if (!projectId)
    return /* @__PURE__ */ jsxDEV8(ProjectsNewRoute, {}, undefined, false, undefined, this);
  return /* @__PURE__ */ jsxDEV8(ProjectsPageFrame, {
    children: /* @__PURE__ */ jsxDEV8(ProjectDetail, {
      projectId,
      onBack: () => router.push("/projects"),
      onEditChange: (editing) => {
        if (editing)
          router.replace(`/projects/${projectId}/edit`);
      }
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function ProjectEditRoute({ params, id }) {
  const router = useRouter3();
  const projectId = id ?? params?.id;
  if (!projectId)
    return /* @__PURE__ */ jsxDEV8(ProjectsNewRoute, {}, undefined, false, undefined, this);
  return /* @__PURE__ */ jsxDEV8(ProjectsPageFrame, {
    children: /* @__PURE__ */ jsxDEV8(ProjectDetail, {
      projectId,
      onBack: () => router.push("/projects"),
      initialEdit: true,
      onEditChange: (editing) => {
        if (!editing)
          router.replace(`/projects/${projectId}`);
      }
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
registerPlugin({
  id: "projects",
  navItems,
  routes: {
    "/projects": ProjectsIndexRoute,
    "/projects/new": ProjectsNewRoute,
    "/projects/[id]": ProjectDetailRoute,
    "/projects/[id]/edit": ProjectEditRoute
  }
});
