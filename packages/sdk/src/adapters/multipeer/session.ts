/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import deepmerge from 'deepmerge';
import { EventEmitter } from 'events';
import {
	Client, InitializeActorMessage, MissingRule, Rules, SessionExecution,
	SessionHandshake, SessionSync, SyncActor, SyncAsset
} from '.';
import { Connection, EventedConnection, Message, UserLike } from '../..';
import { log } from '../../log';
import * as Protocols from '../../protocols';
import * as Payloads from '../../types/network/payloads';

type AssetCreationMessage = Message<Payloads.LoadAssets | Payloads.CreateAsset>;

/**
 * @hidden
 * Class for associating multiple client connections with a single app session.
 */
export class Session extends EventEmitter {
	// tslint:disable:variable-name
	private _clientSet: { [id: string]: Client } = {};
	private _actorSet: { [id: string]: Partial<SyncActor> } = {};
	private _assetSet: { [id: string]: Partial<SyncAsset> } = {};
	private _assetCreatorSet: { [id: string]: AssetCreationMessage } = {};
	private _userSet: { [id: string]: Partial<UserLike> } = {};
	private _protocol: Protocols.Protocol;
	// tslint:enable:variable-name

	public get conn() { return this._conn; }
	public get sessionId() { return this._sessionId; }
	public get protocol() { return this._protocol; }
	public get clients() {
		return Object.values(this._clientSet).sort((a, b) => a.order - b.order);
	}

	public get actors() { return Object.values(this._actorSet); }
	public get assets() { return Object.values(this._assetSet); }
	public get assetCreators() { return Object.values(this._assetCreatorSet); }
	public get users() { return Object.values(this._userSet); }
	public get actorSet() { return this._actorSet; }
	public get assetSet() { return this._assetSet; }
	public get assetCreatorSet() { return this._assetCreatorSet; }
	public get userSet() { return this._userSet; }

	public get rootActors() {
		return Object.values(this._actorSet)
			.filter(actor => !this._actorSet[actor.actorId].initialization.message.payload.actor.parentId);
	}
	public get authoritativeClient() { return this.clients.find(client => client.authoritative); }
	public get peerAuthoritative() { return this._peerAuthoritative; }

	public client = (clientId: string) => this._clientSet[clientId];
	public actor = (actorId: string) => this._actorSet[actorId];
	public user = (userId: string) => this._userSet[userId];
	public childrenOf = (parentId: string) => {
		return this.actors.filter(actor => actor.initialization.message.payload.actor.parentId === parentId);
	}
	public creatableChildrenOf = (parentId: string) => {
		return this.actors.filter(actor =>
			actor.initialization.message.payload.actor.parentId === parentId
			&& !!actor.initialization.message.payload.type);
	}

	/**
	 * Creates a new Session instance
	 */
	// tslint:disable-next-line:variable-name
	constructor(private _conn: Connection, private _sessionId: string, private _peerAuthoritative: boolean) {
		super();
		this.recvFromClient = this.recvFromClient.bind(this);
		this.recvFromApp = this.recvFromApp.bind(this);
		this.disconnect = this.disconnect.bind(this);
		this.leave = this.leave.bind(this);
		this._conn.on('close', this.disconnect);
		this._conn.on('error', this.disconnect);
	}

	/**
	 * Performs handshake and sync with the app
	 */
	public async connect() {
		try {
			const handshake = this._protocol = new SessionHandshake(this);
			await handshake.run();

			const sync = this._protocol = new SessionSync(this);
			await sync.run();

			const execution = this._protocol = new SessionExecution(this);
			execution.on('recv', message => this.recvFromApp(message));
			execution.startListening();
		} catch (e) {
			log.error('network', e);
			this.disconnect();
		}
	}

	public disconnect() {
		try {
			this._conn.off('close', this.disconnect);
			this._conn.off('error', this.disconnect);
			this._conn.close();
			this.emit('close');
		} catch { }
	}

	/**
	 * Adds the client to the session
	 */
	public async join(client: Client) {
		try {
			this._clientSet[client.id] = client;
			client.on('close', () => this.leave(client.id));
			// Synchronize app state to the client.
			await client.join(this);
			// Once the client is joined, further messages from the client will be processed by the session
			// (as opposed to a protocol class).
			client.on('recv', (_: Client, message: Message) => this.recvFromClient(client, message));
			// If we don't have an authoritative client, make this client authoritative.
			if (!this.authoritativeClient) {
				this.setAuthoritativeClient(client.id);
			}
		} catch (e) {
			log.error('network', e);
			this.leave(client.id);
		}
	}

	/**
	 * Removes the client from the session
	 */
	public leave(clientId: string) {
		try {
			const client = this._clientSet[clientId];
			delete this._clientSet[clientId];
			if (client) {
				// If the client is associated with a userId, inform app the user is leaving
				if (client.userId) {
					this.protocol.sendPayload({
						type: 'user-left',
						userId: client.userId
					} as Payloads.UserLeft);
				}
				// Select another client to be the authoritative peer.
				// TODO: Make selection criteria more intelligent (look at latency, prefer non-mobile, ...)
				if (client.authoritative) {
					const nextClient = this.clients.find(c => c.isJoined());
					if (nextClient) {
						this.setAuthoritativeClient(nextClient.id);
					}
				}
			}
			// If this was the last client then shutdown the session
			if (!this.clients.length) {
				this._conn.close();
			}
		} catch { }
	}

	private setAuthoritativeClient(clientId: string) {
		if (!this._clientSet[clientId]) {
			// tslint:disable-next-line:no-console
			log.error('network', `[ERROR] setAuthoritativeClient: client ${clientId} does not exist.`);
		}
		const oldAuthority = this.authoritativeClient;
		const newAuthority = this._clientSet[clientId];

		newAuthority.setAuthoritative(true);
		for (const client of this.clients.filter(c => c !== newAuthority)) {
			client.setAuthoritative(false);
		}

		// forward network stats from the authoritative peer connection to the app
		const toApp = this.conn instanceof EventedConnection ? this.conn : null;
		const forwardIncoming = (bytes: number) => toApp.statsTracker.recordIncoming(bytes);
		const forwardOutgoing = (bytes: number) => toApp.statsTracker.recordOutgoing(bytes);
		const toNewAuthority = newAuthority.conn instanceof EventedConnection ? newAuthority.conn : null;
		if (toNewAuthority) {
			toNewAuthority.statsTracker.on('incoming', forwardIncoming);
			toNewAuthority.statsTracker.on('outgoing', forwardOutgoing);
		}

		// turn off old authority
		const toOldAuthority = oldAuthority && oldAuthority.conn instanceof EventedConnection
			? oldAuthority.conn : null;
		if (toOldAuthority) {
			toOldAuthority.statsTracker.off('incoming', forwardIncoming);
			toOldAuthority.statsTracker.off('outgoing', forwardOutgoing);
		}
	}

	private recvFromClient = (client: Client, message: Message) => {
		message = this.preprocessFromClient(client, message);
		if (message) {
			this.sendToApp(message);
		}
	}

	private recvFromApp = (message: Message) => {
		message = this.preprocessFromApp(message);
		if (message) {
			this.sendToClients(message);
		}
	}

	public preprocessFromApp(message: Message): Message {
		const rule = Rules[message.payload.type] || MissingRule;
		const beforeReceiveFromApp = rule.session.beforeReceiveFromApp || (() => message);
		return beforeReceiveFromApp(this, message);
	}

	public preprocessFromClient(client: Client, message: Message): Message {
		// Precaution: If we don't recognize this client, drop the message.
		if (!this._clientSet[client.id]) {
			return undefined;
		}
		if (message.payload && message.payload.type && message.payload.type.length) {
			const rule = Rules[message.payload.type] || MissingRule;
			const beforeReceiveFromClient = rule.session.beforeReceiveFromClient || (() => message);
			message = beforeReceiveFromClient(this, client, message);
		}
		return message;
	}

	public sendToApp(message: Message) {
		this.protocol.sendMessage(message);
	}

	public sendToClients(message: Message, filterFn?: (value: Client, index: number) => any) {
		const clients = this.clients.filter(filterFn || (() => true));
		for (const client of clients) {
			client.send({ ...message });
		}
	}

	public sendPayloadToClients(payload: Partial<Payloads.Payload>, filterFn?: (value: Client, index: number) => any) {
		this.sendToClients({ payload }, filterFn);
	}

	public findAnimation(syncActor: Partial<SyncActor>, animationName: string) {
		return (syncActor.createdAnimations || []).find(item => item.message.payload.animationName === animationName);
	}

	public isAnimating(syncActor: Partial<SyncActor>): boolean {
		if ((syncActor.createdAnimations || []).some(item => item.enabled)) {
			return true;
		}
		if (syncActor.initialization &&
			syncActor.initialization.message &&
			syncActor.initialization.message.payload &&
			syncActor.initialization.message.payload.actor) {
			const parent = this._actorSet[syncActor.initialization.message.payload.actor.parentId];
			if (parent) {
				return this.isAnimating(parent);
			}
		}
		return false;
	}

	public cacheInitializeActorMessage(message: InitializeActorMessage) {
		let syncActor = this.actorSet[message.payload.actor.id];
		if (!syncActor) {
			const parent = this.actorSet[message.payload.actor.parentId];
			syncActor = this.actorSet[message.payload.actor.id] = {
				actorId: message.payload.actor.id,
				exclusiveToUser: parent && parent.exclusiveToUser
					|| message.payload.actor.exclusiveToUser,
				initialization: deepmerge({ message }, {})
			};
		// update reserved actor init message with something the client can use
		} else if (syncActor.initialization.message.payload.type === 'x-reserve-actor') {
			// send real init message, but with session's initial actor state
			message.payload = {
				...message.payload,
				actor: syncActor.initialization.message.payload.actor
			};
			// write the merged message back to the session
			syncActor.initialization.message = message;
		}
	}

	public cacheActorUpdateMessage(message: Message<Payloads.ActorUpdate>) {
		const syncActor = this.actorSet[message.payload.actor.id];
		if (syncActor) {
			// Merge the update into the existing actor.
			syncActor.initialization.message.payload.actor
				= deepmerge(syncActor.initialization.message.payload.actor, message.payload.actor);

			// strip out transform data that wasn't updated
			// so it doesn't desync from the updated one
			const cacheTransform = syncActor.initialization.message.payload.actor.transform;
			const patchTransform = message.payload.actor.transform;
			if (patchTransform && patchTransform.app && cacheTransform.local) {
				delete cacheTransform.local.position;
				delete cacheTransform.local.rotation;
			} else if (patchTransform && patchTransform.local) {
				delete cacheTransform.app;
			}
		}
	}

	public cacheAssetCreationRequest(message: AssetCreationMessage) {
		this.assetCreatorSet[message.id] = message;
	}

	public cacheAssetCreation(assetId: string, creatorId: string, duration?: number) {
		const syncAsset = this.assetSet[assetId] = { id: assetId, duration } as Partial<SyncAsset>;
		const creator = this.assetCreatorSet[creatorId];
		syncAsset.creatorMessageId = creatorId;

		// Updates are cached on send, creates are cached on receive,
		// so it's possible something was updated while it was loading.
		// Merge those updates into creation once the create comes back.
		if (creator.payload.type === 'create-asset' && syncAsset.update) {
			creator.payload.definition = deepmerge(
				creator.payload.definition,
				syncAsset.update.payload.asset
			);
			syncAsset.update = undefined;
		}
	}

	public cacheAssetUpdate(update: Message<Payloads.AssetUpdate>) {
		const syncAsset = this.assetSet[update.payload.asset.id] =
			this.assetSet[update.payload.asset.id] || { id: update.payload.asset.id };
		const creator = this.assetCreatorSet[syncAsset.creatorMessageId];

		if (creator && creator.payload.type === 'create-asset') {
			// roll update into creation message
			creator.payload.definition = deepmerge(
				creator.payload.definition,
				update.payload.asset);
		} else if (syncAsset.update) {
			// merge with previous update message
			syncAsset.update.payload.asset = deepmerge(
				syncAsset.update.payload.asset,
				update.payload.asset);
		} else {
			// just save it
			syncAsset.update = update;
		}
	}

	public cacheAssetUnload(containerId: string) {
		const creators = this.assetCreators.filter(c => c.payload.containerId === containerId);
		for (const creator of creators) {
			// un-cache creation message
			delete this.assetCreatorSet[creator.id];

			// un-cache created assets
			const assets = this.assets.filter(a => a.creatorMessageId === creator.id);
			for (const asset of assets) {
				delete this.assetSet[asset.id];
			}
		}
	}
}
