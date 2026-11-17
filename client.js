// dsh-session-cleaner v2 — browser half.
//
// Loaded by the web app's module loader as /plugins/dsh-session-cleaner/client.js.
//
// v1 had to fake the sidebar menu from the DOM: it watched for [role="menu"],
// matched the row by title, and resolved the session id by POSTing
// /api/session.list — an endpoint this runtime does not have. v2 uses the
// supported extension point instead: the `sidebar.workspaces.session.menu.item`
// slot, declared by @deepseek-ai/dsh-client-ui-workspace, hands the component
// its sessionId, its displayTitle and the menu dismissal callback. Nothing is
// scraped, so nothing can silently drift.
//
// Deliberately no `@deepseek-ai/*` imports: only `react` and the `ctx`
// services. A client bundle that requires a package this build does not ship
// fails to load at all, which is exactly how v1 disappeared (it listed
// `@deepseek-ai/dsh-client-runtime`, a package that no longer exists).

window.__ModuleLoader__.load({
	id: 'dsh-session-cleaner',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const React = require('react');

		const NS = 'sessionCleaner';

		const zh = {
			delete: '删除此会话',
			confirm: '确定删除会话「{title}」？会话文件会被永久删除，无法恢复。',
			failed: '删除失败：',
			nohost: '宿主端点未注册（插件没启用或 DSH 没重启）',
			running: '会话正在运行，无法删除'
		};
		const en = {
			delete: 'Delete session',
			confirm: 'Delete session "{title}"? Its files are removed permanently and cannot be recovered.',
			failed: 'Delete failed: ',
			nohost: 'host endpoint not registered (plugin disabled or DSH not restarted)',
			running: 'The session is running and cannot be deleted'
		};

		const log = (...args) => {
			try {
				console.debug('[dsh-session-cleaner]', ...args);
			} catch {
				/* console unavailable */
			}
		};

		function messageOf(error) {
			if (error instanceof Error) return error.message;
			return String(error);
		}

		/**
		 * POST the host delete route. A 404 or a non-JSON body means the host
		 * half never mounted, which is worth saying plainly instead of
		 * surfacing "HTTP 404" to the user.
		 */
		async function requestDelete(sessionId, t) {
			const response = await fetch('/api-ext/session.delete', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId })
			});
			const body = await response.json().catch(() => undefined);
			if (body === undefined) {
				if (response.status === 404) throw new Error(t('nohost'));
				throw new Error('HTTP ' + response.status);
			}
			if (body.ok !== true) throw new Error(body.error?.message ?? 'HTTP ' + response.status);
			log('deleted', sessionId, body.value);
			return body.value;
		}

		/** The menu row. Props come from the slot owner plus our inject face. */
		function DeleteMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState, remove, t } = props;
			// Stable per build: the slot either supplies the hook or it does not.
			const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : [false, () => {}];
			const closeMenu = menuState[1];
			const [busy, setBusy] = React.useState(false);

			const onClick = async (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (busy === true) return;
				if (!window.confirm(t('confirm', { title: displayTitle ?? sessionId }))) return;
				setBusy(true);
				try {
					await remove(sessionId);
					closeMenu(false);
				} catch (error) {
					window.alert(t('failed') + messageOf(error));
				} finally {
					setBusy(false);
				}
			};

			return React.createElement(
				'button',
				{
					type: 'button',
					role: 'menuitem',
					'data-session-cleaner': 'delete',
					title: busy ? '…' : t('delete'),
					onClick,
					style: {
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						width: '100%',
						padding: '6px 12px',
						border: 'none',
						borderTop: '1px solid var(--dsw-alias-hairline, rgba(128,128,128,.25))',
						background: 'none',
						color: 'var(--dsw-alias-danger, #e5484d)',
						font: 'inherit',
						fontSize: '13px',
						textAlign: 'left',
						cursor: 'pointer',
						opacity: busy ? '0.5' : '1'
					}
				},
				'🗑 ' + t('delete')
			);
		}

		function apply(ctx) {
			log('apply');

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cleaner: dictionaries');

			const remove = async (sessionId) => {
				const t = ctx.locale.bind(NS);
				const value = await requestDelete(sessionId, t);
				// The host detached the live entry, so the control stream should
				// drop the row by itself; an explicit refresh closes the gap when
				// this build exposes one.
				try {
					await ctx.sessions?.refresh?.();
				} catch {
					/* refresh is best effort */
				}
				return value;
			};

			ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
				ctx.slots.register(
					{
						name: 'sidebar.workspaces.session.menu.item',
						id: 'dsh-session-cleaner.delete',
						// Shipped entries end at Archive (400); land after the plugin group.
						order: 700,
						locale: NS,
						inject: () => ({ remove })
					},
					DeleteMenuItem
				)
			);
		}

		exports.apply = apply;
		exports.inject = ['slots', 'locale', 'sessions'];
		return module.exports;
	}
});
