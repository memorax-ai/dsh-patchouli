const inputTriggerTarget = {
	package: '@deepseek-ai/dsh-client-ui-input-trigger',
	version: '>=0.1.1-rc.2 <0.1.2-0',
	file: 'lib/client.js',
}

/** @type {import('dsh-harmony').HarmonyPatch[]} */
module.exports = [{
	id: 'native-context-at-stream',
	target: inputTriggerTarget,
	select: 'MethodDeclaration[name.name="fetchCandidates"] ForOfStatement',
	expect: 1,
	apply({ node, sourceFile, edit }) {
		edit.overwrite(
			node.getStart(sourceFile),
			node.getEnd(),
			String.raw`for (const source of roster) {
					const settle = (items) => {
						if (controller.signal.aborted) return;
						this.reduce({ type: "source-settled", generation, source: source.name, items });
					};
					const fail = (error) => {
						if (controller.signal.aborted) return;
						console.error('[ui-input-trigger] source "' + source.name + '" candidates failed:', error);
						this.reduce({ type: "source-failed", generation, source: source.name });
					};
					(async () => {
						try {
							const result = await source.candidates(projection, {
								query: hit.query,
								quoted: hit.quoted,
								position: hit.position,
								signal: controller.signal
							});
							if (result != null && typeof result[Symbol.asyncIterator] === "function") {
								for await (const items of result) settle(items);
							} else {
								settle(result);
							}
						} catch (error) {
							fail(error);
						}
					})();
				}`,
		)
	},
}, {
	id: 'native-context-at-source-order',
	target: inputTriggerTarget,
	select: 'MethodDeclaration[name.name="track"] VariableDeclaration[name.name="roster"]',
	expect: 1,
	apply({ node, sourceFile, edit, ts }) {
		if (!ts.isVariableDeclaration(node) || node.initializer === undefined) {
			throw new Error('Patchouli @ roster is no longer an initialized declaration')
		}
		edit.overwrite(
			node.initializer.getStart(sourceFile),
			node.initializer.getEnd(),
			String.raw`[...this.deps.roster.sources(hit.trigger)].sort((left, right) =>
				(left.name === "patchouli-reference" ? 0 : left.name === "reference" ? 1 : 2)
				- (right.name === "patchouli-reference" ? 0 : right.name === "reference" ? 1 : 2))`,
		)
	},
}, {
	id: 'native-context-at-boundary-highlight',
	target: inputTriggerTarget,
	select: 'CaseClause VariableDeclaration[name.name="highlight"]',
	expect: 2,
	apply({ node, sourceFile, edit, ts }) {
		let owner = node.parent
		while (owner !== undefined && !ts.isCaseClause(owner)) owner = owner.parent
		if (owner === undefined || owner.expression.getText(sourceFile) !== '"source-settled"') return
		if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return
		edit.overwrite(
			node.initializer.getStart(sourceFile),
			node.initializer.getEnd(),
			String.raw`ev.source === "reference"
				&& groups.some((group) => group.source === "patchouli-reference")
				&& groups[idx]?.items.length > 0
				? { source: "reference", index: 0 }
				: validHighlight(state.highlight, groups) ?? firstHighlight(groups)`,
		)
	},
}, {
	id: 'native-context-at-bounded-navigation',
	target: inputTriggerTarget,
	select: 'FunctionDeclaration[name.name="positions"]',
	expect: 1,
	apply({ node, sourceFile, edit }) {
		edit.overwrite(
			node.getStart(sourceFile),
			node.getEnd(),
			String.raw`const PATCHOULI_SOURCE = "patchouli-reference";
		const PATCHOULI_PAGE_SIZE = 10;
		function visibleCount(group) {
			return group.source === PATCHOULI_SOURCE
				? Math.min(group.items.length, group.visibleCount ?? PATCHOULI_PAGE_SIZE)
				: group.items.length;
		}
		function visibleItems(group) {
			return group.items.slice(0, visibleCount(group));
		}
		function positions(groups) {
			const out = [];
			for (const g of groups) {
				if (g.status !== "ready") continue;
				const count = visibleCount(g);
				if (g.source === PATCHOULI_SOURCE) {
					for (let i = count - 1; i >= 0; i--) out.push({ source: g.source, index: i });
				} else {
					for (let i = 0; i < count; i++) out.push({ source: g.source, index: i });
				}
			}
			return out;
		}`,
		)
	},
}, {
	id: 'native-context-at-progressive-navigation',
	target: inputTriggerTarget,
	select: 'CaseClause[expression.text="move"]',
	expect: 1,
	apply({ node, sourceFile, edit }) {
		edit.overwrite(
			node.getStart(sourceFile),
			node.getEnd(),
			String.raw`case "move": {
					if (!state.open) return state;
					const pos = positions(state.groups);
					if (pos.length === 0) return state;
					const hl = state.highlight;
					const at = hl ? pos.findIndex((p) => p.source === hl.source && p.index === hl.index) : -1;
					if (at < 0) {
						const next = pos[ev.dir === 1 ? 0 : pos.length - 1];
						return next === void 0 ? state : { ...state, highlight: next };
					}
					const target = at + ev.dir;
					if (target >= 0 && target < pos.length) {
						const next = pos[target];
						if (next === void 0 || hl && next.source === hl.source && next.index === hl.index) return state;
						return { ...state, highlight: next };
					}
					if (ev.dir === -1 && hl?.source === PATCHOULI_SOURCE) {
						const group = state.groups.find((item) => item.source === PATCHOULI_SOURCE);
						const count = group === void 0 ? 0 : visibleCount(group);
						if (group !== void 0 && hl.index === count - 1 && count < group.items.length) {
							const groups = state.groups.map((item) => item.source === PATCHOULI_SOURCE
								? { ...item, visibleCount: Math.min(item.items.length, count + PATCHOULI_PAGE_SIZE) }
								: item);
							return { ...state, groups, highlight: { source: PATCHOULI_SOURCE, index: count } };
						}
					}
					return state;
				}`,
		)
	},
}, {
	id: 'native-context-at-mirrored-menu',
	target: inputTriggerTarget,
	select: 'FunctionDeclaration[name.name="MenuView"]',
	expect: 1,
	apply({ node, sourceFile, edit }) {
		edit.overwrite(
			node.getStart(sourceFile),
			node.getEnd(),
			String.raw`function MenuView({ menu, onPick, onDismiss, t }) {
			const state = (0, react.useSyncExternalStore)((fn) => menu.subscribe(fn), () => menu.getSnapshot());
			const listRef = (0, react.useRef)(null);
			const detailRef = (0, react.useRef)(null);
			const hoverTimerRef = (0, react.useRef)(null);
			const [hovered, setHovered] = (0, react.useState)(null);
			const [detailPosition, setDetailPosition] = (0, react.useState)(null);
			const maxHeight = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredMaxHeight)(listRef, MAX_HEIGHT, state);
			const highlight = state.open ? state.highlight : null;
			const patchouli = state.groups.find((group) => group.source === PATCHOULI_SOURCE);
			const detailTarget = hovered?.source === PATCHOULI_SOURCE
				? hovered
				: highlight?.source === PATCHOULI_SOURCE ? highlight : null;
			const detailItem = detailTarget === null ? void 0 : patchouli?.items[detailTarget.index];
			const hasDetail = typeof detailItem?.detail === "string" && detailItem.detail.trim() !== "";
			const cancelHoverClear = () => {
				if (hoverTimerRef.current === null) return;
				clearTimeout(hoverTimerRef.current);
				hoverTimerRef.current = null;
			};
			const scheduleHoverClear = () => {
				cancelHoverClear();
				hoverTimerRef.current = setTimeout(() => {
					hoverTimerRef.current = null;
					setHovered(null);
				}, 100);
			};
			(0, react.useEffect)(() => {
				if (highlight === null) return;
				document.getElementById(optionId(highlight.source, highlight.index))?.scrollIntoView({ block: "nearest" });
			}, [state.open, highlight?.source, highlight?.index, state.groups]);
			(0, react.useEffect)(() => () => cancelHoverClear(), []);
			(0, react.useEffect)(() => {
				if (!state.open) setHovered(null);
			}, [state.open]);
			(0, react.useEffect)(() => {
				if (!state.open || detailTarget === null || !hasDetail) {
					setDetailPosition(null);
					return;
				}
				let frame = 0;
				const update = () => {
					const anchor = document.getElementById(optionId(detailTarget.source, detailTarget.index));
					if (anchor === null) {
						setDetailPosition(null);
						return;
					}
					const rect = anchor.getBoundingClientRect();
					const margin = 12;
					const gap = 8;
					const width = Math.min(320, window.innerWidth - margin * 2);
					const right = rect.right + gap;
					const left = right + width <= window.innerWidth - margin
						? right
						: Math.max(margin, rect.left - gap - width);
					const height = Math.min(detailRef.current?.getBoundingClientRect().height ?? 80, window.innerHeight - margin * 2);
					const top = Math.min(Math.max(margin, rect.top), Math.max(margin, window.innerHeight - margin - height));
					setDetailPosition((current) => current?.left === left && current?.top === top && current?.width === width
						? current
						: { left, top, width });
				};
				update();
				frame = requestAnimationFrame(update);
				window.addEventListener("resize", update);
				window.addEventListener("scroll", update, true);
				return () => {
					cancelAnimationFrame(frame);
					window.removeEventListener("resize", update);
					window.removeEventListener("scroll", update, true);
				};
			}, [state, detailTarget?.source, detailTarget?.index, hasDetail, detailItem?.detail]);
			(0, react.useEffect)(() => {
				if (!state.open) return;
				const onPointerDown = (ev) => {
					if (!(ev.target instanceof Node)) return;
					if (listRef.current?.contains(ev.target)) return;
					if (detailRef.current?.contains(ev.target)) return;
					if ((listRef.current?.closest("[data-composer-card]"))?.contains(ev.target)) return;
					onDismiss();
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => document.removeEventListener("pointerdown", onPointerDown, true);
			}, [state.open, onDismiss]);
			if (!state.open) return null;
			const renderItem = (group, item, index) => {
				const active = highlight !== null && highlight.source === group.source && highlight.index === index;
				const button = (0, react_jsx_runtime.jsxs)("button", {
					id: optionId(group.source, index),
					type: "button",
					role: "option",
					"aria-selected": active,
					"aria-description": group.source === PATCHOULI_SOURCE ? item.detail : void 0,
					className: clsx(MenuView_module_css_default.item, active && MenuView_module_css_default.active),
					onMouseEnter: group.source === PATCHOULI_SOURCE && typeof item.detail === "string" && item.detail.trim() !== "" ? () => {
						cancelHoverClear();
						setHovered({ source: group.source, index });
					} : void 0,
					onMouseLeave: group.source === PATCHOULI_SOURCE ? scheduleHoverClear : void 0,
					onMouseDown: (ev) => {
						ev.preventDefault();
						onPick(group.source, index);
					},
					children: [
						item.icon !== void 0 && (0, react_jsx_runtime.jsx)("span", {
							className: MenuView_module_css_default.itemIcon,
							"aria-hidden": true,
							children: item.icon
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: MenuView_module_css_default.itemName,
							children: item.name
						}),
						item.description !== void 0 && (0, react_jsx_runtime.jsx)("span", {
							className: MenuView_module_css_default.itemDescription,
							children: item.description
						})
					]
				});
				return button;
			};
			const nativeGroups = state.groups.filter((group) => group.source !== PATCHOULI_SOURCE);
			const patchouliContent = patchouli === void 0 || patchouli.status === "ready" && patchouli.items.length === 0
				? null
				: (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [
					patchouli.status === "pending"
						? (0, react_jsx_runtime.jsx)("div", {
							className: MenuView_module_css_default.loading,
							"data-source": patchouli.source,
							children: t("loading")
						})
						: visibleItems(patchouli).map((item, index) => ({ item, index })).reverse().map(({ item, index }) => renderItem(patchouli, item, index)),
					patchouli.status === "ready" && patchouli.items[0]?.section !== void 0
						? (0, react_jsx_runtime.jsx)("div", {
							className: MenuView_module_css_default.sectionTitle,
							role: "presentation",
							children: patchouli.items[0].section
						})
						: null
				] }, patchouli.source);
			const hasNativeContent = nativeGroups.some((group) => group.status === "pending" || group.items.length > 0);
			const detailPortal = !hasDetail || detailPosition === null ? null : require("react-dom").createPortal((0, react_jsx_runtime.jsx)("div", {
				ref: detailRef,
				className: "dsh-patchouli-at-detail-shell",
				style: detailPosition,
				onMouseEnter: cancelHoverClear,
				onMouseLeave: () => {
					cancelHoverClear();
					setHovered(null);
				},
				children: (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-patchouli-at-detail",
					children: detailItem.detail
				})
			}), document.body);
			return (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [(0, react_jsx_runtime.jsx)("div", {
				ref: listRef,
				className: MenuView_module_css_default.menu,
				style: { maxHeight },
				role: "listbox",
				"aria-label": t("suggestions.aria"),
				"aria-activedescendant": highlight !== null ? optionId(highlight.source, highlight.index) : void 0,
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: MenuView_module_css_default.viewport,
					children: [
						patchouliContent,
						patchouliContent !== null && hasNativeContent ? (0, react_jsx_runtime.jsx)("div", {
							role: "presentation",
							"aria-hidden": true,
							style: { height: 1, flex: "none", margin: "4px 10px", background: "var(--dsw-alias-border-l2)" }
						}) : null,
						...nativeGroups.map((group) => group.status === "ready" && group.items.length === 0 ? null : (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [
							group.showGroupTitle === false || group.items.some((item) => item.section !== void 0) ? null : (0, react_jsx_runtime.jsx)("div", {
								className: MenuView_module_css_default.groupTitle,
								role: "presentation",
								"data-source": group.source,
								children: t(group.source)
							}),
							group.status === "pending" ? (0, react_jsx_runtime.jsx)("div", {
								className: MenuView_module_css_default.loading,
								"data-source": group.source,
								children: t("loading")
							}) : group.items.map((item, index) => (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [
								item.section !== void 0 && item.section !== group.items[index - 1]?.section ? (0, react_jsx_runtime.jsx)("div", {
									className: MenuView_module_css_default.sectionTitle,
									role: "presentation",
									children: item.section
								}) : null,
								renderItem(group, item, index)
							] }, optionId(group.source, index)))
						] }, group.source))
					]
				})
			}), detailPortal] });
		}`,
		)
	},
}]
