/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import { join } from 'path';
import { TPromise, Promise } from 'vs/base/common/winjs.base';
import { detectMimesFromFile, detectMimesFromStream } from 'vs/base/node/mime';
import { realpath, exists} from 'vs/base/node/pfs';
import { Repository, GitError } from 'vs/workbench/parts/git/node/git.lib';
import { IRawGitService, RawServiceState, IRawStatus, IRef, GitErrorCodes, IPushOptions, ICommitInfo } from 'vs/workbench/parts/git/common/git';
import Event, { Emitter } from 'vs/base/common/event';

export class RawGitService implements IRawGitService {

	private repo: Repository;
	private _repositoryRoot: TPromise<string>;
	private _onOutput: Emitter<string>;
	get onOutput(): Event<string> { return this._onOutput.event; }

	constructor(repo: Repository) {
		this.repo = repo;

		let listener: () => void;

		this._onOutput = new Emitter<string>({
			onFirstListenerAdd: () => {
				listener = this.repo.onOutput(output => this._onOutput.fire(output));
			},
			onLastListenerRemove: () => {
				listener();
				listener = null;
			}
		});
	}

	getVersion(): TPromise<string> {
		return TPromise.as(this.repo.version);
	}

	private getRepositoryRoot(): TPromise<string> {
		return this._repositoryRoot || (this._repositoryRoot = realpath(this.repo.path));
	}

	serviceState(): TPromise<RawServiceState> {
		return TPromise.as<RawServiceState>(this.repo
			? RawServiceState.OK
			: RawServiceState.GitNotFound
		);
	}

	statusCount(): TPromise<number> {
		if (!this.repo) {
			return TPromise.as(0);
		}

		return this.status().then(r => r ? r.status.length : 0);
	}

	status(): TPromise<IRawStatus> {
		return this.repo.getStatus()
			.then(status => this.repo.getHEAD()
				.then(HEAD => {
					if (HEAD.name) {
						return this.repo.getBranch(HEAD.name).then(null, () => HEAD);
					} else {
						return HEAD;
					}
				}, (): IRef => null)
				.then(HEAD => Promise.join([this.getRepositoryRoot(), this.repo.getRefs(), this.repo.getRemotes()]).then(r => {
					return {
						repositoryRoot: r[0],
						status: status,
						HEAD: HEAD,
						refs: r[1],
						remotes: r[2]
					};
				})))
			.then(null, (err) => {
				if (err.gitErrorCode === GitErrorCodes.BadConfigFile) {
					return Promise.wrapError(err);
				} else if (err.gitErrorCode === GitErrorCodes.NotAtRepositoryRoot) {
					return Promise.wrapError(err);
				}

				return null;
			});
	}

	init(): TPromise<IRawStatus> {
		return this.repo.init().then(() => this.status());
	}

	add(filePaths?: string[]): TPromise<IRawStatus> {
		return this.repo.add(filePaths).then(() => this.status());
	}

	stage(filePath: string, content: string): TPromise<IRawStatus> {
		return this.repo.stage(filePath, content).then(() => this.status());
	}

	branch(name: string, checkout?: boolean): TPromise<IRawStatus> {
		return this.repo.branch(name, checkout).then(() => this.status());
	}

	checkout(treeish?: string, filePaths?: string[]): TPromise<IRawStatus> {
		return this.repo.checkout(treeish, filePaths).then(() => this.status());
	}

	clean(filePaths: string[]): TPromise<IRawStatus> {
		return this.repo.clean(filePaths).then(() => this.status());
	}

	undo(): TPromise<IRawStatus> {
		return this.repo.undo().then(() => this.status());
	}

	reset(treeish: string, hard?: boolean): TPromise<IRawStatus> {
		return this.repo.reset(treeish, hard).then(() => this.status());
	}

	revertFiles(treeish: string, filePaths?: string[]): TPromise<IRawStatus> {
		return this.repo.revertFiles(treeish, filePaths).then(() => this.status());
	}

	fetch(): TPromise<IRawStatus> {
		return this.repo.fetch().then(null, (err) => {
			if (err.gitErrorCode === GitErrorCodes.NoRemoteRepositorySpecified) {
				return TPromise.as(null);
			}

			return Promise.wrapError(err);
		}).then(() => this.status());
	}

	pull(rebase?: boolean): TPromise<IRawStatus> {
		return this.repo.pull(rebase).then(() => this.status());
	}

	push(remote?: string, name?: string, options?:IPushOptions): TPromise<IRawStatus> {
		return this.repo.push(remote, name, options).then(() => this.status());
	}

	sync(): TPromise<IRawStatus> {
		return this.repo.sync().then(() => this.status());
	}

	commit(message:string, amend?: boolean, stage?: boolean): TPromise<IRawStatus> {
		let promise: Promise = TPromise.as(null);

		if (stage) {
			promise = this.repo.add(null);
		}

		return promise
			.then(() => this.repo.commit(message, stage, amend))
			.then(() => this.status());
	}

	detectMimetypes(filePath: string, treeish?: string): TPromise<string[]> {
		return exists(join(this.repo.path, filePath)).then((exists) => {
			if (exists) {
				return new TPromise<string[]>((c, e) => {
					detectMimesFromFile(join(this.repo.path, filePath), (err, result) => {
						if (err) { e(err); }
						else { c(result.mimes); }
					});
				});
			}

			const child = this.repo.show(treeish + ':' + filePath);

			return new TPromise<string[]>((c, e) => {
				detectMimesFromStream(child.stdout, filePath, (err, result) => {
					if (err) { e(err); }
					else { c(result.mimes); }
				});
			});
		});
	}

	// careful, this buffers the whole object into memory
	show(filePath: string, treeish?: string): TPromise<string> {
		treeish = (!treeish || treeish === '~') ? '' : treeish;
		return this.repo.buffer(treeish + ':' + filePath).then(null, e => {
			if (e instanceof GitError) {
				return ''; // mostly untracked files end up in a git error
			}

			return TPromise.wrapError<string>(e);
		});
	}

	/**
	 * Gets `ICommitInfo`, including the template and previous commit message.
	 * @returns `IRawStatus` with `commitInfo` set.
	 */
	getCommitInfo(): TPromise<IRawStatus> {
		console.log('RawGitService.getCommitInfo');

		return Promise.join([
			this.repo.run(['config', '--get', 'commit.template']).then(filename => {
				console.log(`getCommitInfo.config filename=> ${filename}`);
				return filename;
			}, err => {
				console.log(`getCommitInfo.config err=> ${err.message}`);
				return "";
			}),
			this.repo.getLog({ prevCount: 1, format: '%B' }).then(log => log, err => ""),
			this.status()
		]).then(r => {
			console.log('RawGitService.getCommitInfo=>Promise.join');
			let status = <IRawStatus>r[2];
			status.commitInfo = {
				template: r[0] ? this.readCommitTemplateFile(r[0].stdout.trim()) : "",
				prevCommitMsg: r[1]
			};
			return status;
		});;
	}

	/**
	 * Reads the given file, if exists and is valid.
	 * @returns commit template file contents if exists and valid, else ""
	 */
	private readCommitTemplateFile(file: string): string {
		try {
			// Check the file itself
			if (fs.existsSync(file)) {
				return fs.readFileSync(file, 'utf8');
			} else {
				// File doesn't exist. Try converting ~/path to absolute path
				console.log(`file doesnt exist. file: ${file}`);

				// Try checking in local repo git folder
				let repo_file = file.replace('~', `${this.repo.path}\\.git`).replace('/', '\\');
				if (fs.existsSync(repo_file)) {
					return fs.readFileSync(repo_file, 'utf8');
				} else {
					// Check global (not implemented)
					console.error(`file doesnt exist in repo local git config. repo_file: ${repo_file}`);
					return "";
				}
			}
		} catch (error) {
			console.error(`Error reading file. file: ${file}, error: ${error.message})`);
			return "";
		}
	}
}
