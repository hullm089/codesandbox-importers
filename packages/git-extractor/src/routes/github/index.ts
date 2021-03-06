import { Context } from "koa";
import createSandbox from "codesandbox-import-utils/lib/create-sandbox";
import normalizeSandbox from "codesandbox-import-utils/lib/utils/files/normalize";
import { IModule, INormalizedModules } from "codesandbox-import-util-types";

import { downloadRepository } from "./pull/download";
import * as api from "./api";

import * as push from "./push";

import { IGitInfo } from "./push";

const getUserToken = (ctx: Context) => {
  const header = ctx.header.authorization;
  if (header) {
    if (header.startsWith("Bearer ")) {
      return header.replace("Bearer ", "");
    }
    return header;
  }

  return undefined;
};

export const info = async (ctx: Context, next: () => Promise<any>) => {
  const userToken = getUserToken(ctx);
  const response = await api.fetchRepoInfo(
    ctx.params.username,
    ctx.params.repo,
    ctx.params.branch,
    ctx.params.path,
    false,
    userToken
  );

  ctx.body = response;
};

export const pullInfo = async (ctx: Context, next: () => Promise<any>) => {
  const userToken = getUserToken(ctx);
  const { username, repo, branch } = await api.fetchPullInfo(
    ctx.params.username,
    ctx.params.repo,
    ctx.params.pull,
    userToken
  );

  const response = await api.fetchRepoInfo(
    username,
    repo,
    branch,
    "",
    false,
    userToken
  );

  ctx.body = response;
};

export const getRights = async (ctx: Context) => {
  const userToken = getUserToken(ctx);

  const rights = await api.fetchRights(
    ctx.params.username,
    ctx.params.repo,
    userToken
  );

  ctx.body = {
    permission: rights
  };
};

/**
 * This route will take a github path and return sandbox data for it
 *
 * Data contains all files, directories and package.json info
 */
export const data = async (ctx: Context, next: () => Promise<any>) => {
  // We get branch, etc from here because there could be slashes in a branch name,
  // we can retrieve if this is the case from this method
  const { username, repo, branch, commitSha, currentUsername } = ctx.params;
  const userToken = getUserToken(ctx);

  const path = ctx.params.path && ctx.params.path.replace("+", " ");

  let title = `${username}/${repo}`;
  if (path) {
    const splittedPath = path.split("/");
    title = title + `: ${splittedPath[splittedPath.length - 1]}`;
  }

  const downloadedFiles = await downloadRepository(
    {
      username,
      repo,
      branch,
      path
    },
    commitSha,
    userToken
  );

  let isPrivate = false;

  if (userToken) {
    isPrivate = await api.isRepoPrivate(username, repo, userToken);
  }

  if (isPrivate) {
    api.resetShaCache({ branch, username, repo, path });
  }

  console.log(
    `Creating sandbox for ${username}/${repo}, branch: ${branch}, path: ${path}`
  );

  const sandboxParams = await createSandbox(downloadedFiles);

  const finalTitle = sandboxParams.title || title;

  ctx.body = {
    ...sandboxParams,
    // If no title is set in package.json, go for this one
    title: finalTitle,

    // Privacy 2 is private, privacy 0 is public
    privacy: isPrivate ? 2 : 0
  };
};

export const diff = async (ctx: Context, next: () => Promise<any>) => {
  const { modules, directories, commitSha, token } = ctx.request.body;

  const { username, repo, branch, path } = ctx.params;

  const normalizedFiles = normalizeSandbox(modules, directories);

  const [delta, rights] = await Promise.all([
    push.getFileDifferences(
      { username, repo, branch, path },
      commitSha,
      normalizedFiles,
      token
    ),
    api.fetchRights(username, repo, token)
  ]);

  ctx.body = {
    added: delta.added,
    modified: delta.modified,
    deleted: delta.deleted,
    rights
  };
};

export const pr = async (ctx: Context, next: () => Promise<any>) => {
  const {
    modules,
    directories,
    commitSha,
    message,
    currentUser,
    token
  } = ctx.request.body;
  const normalizedFiles = normalizeSandbox(modules, directories);

  const { username, repo, branch, path } = ctx.params;

  let gitInfo: IGitInfo = {
    username,
    repo,
    branch,
    path
  };

  const rights = await api.fetchRights(username, repo, token);

  if (rights === "none" || rights === "read") {
    // Ah, we need to fork...
    gitInfo = await push.createFork(gitInfo, currentUser, token);
  }

  const commit = await push.createCommit(
    gitInfo,
    normalizedFiles,
    commitSha,
    message,
    token
  );

  const res = await push.createBranch(gitInfo, commit.sha, token);

  ctx.body = {
    url: res.url,
    newBranch: res.branchName,
    sha: commit.sha
  };
};

export const commit = async (ctx: Context, next: () => Promise<any>) => {
  const { modules, directories, commitSha, message, token } = ctx.request.body;
  const normalizedFiles = normalizeSandbox(modules, directories);

  const { username, repo, branch, path } = ctx.params;

  const gitInfo: IGitInfo = {
    username,
    repo,
    branch,
    path
  };

  const commit = await push.createCommit(
    gitInfo,
    normalizedFiles,
    commitSha,
    message,
    token
  );

  // On the client we redirect to the original git sandbox, so we want to
  // reset the cache so the user sees the latest version
  api.resetShaCache({ username, repo, branch, path });

  const lastInfo = await api.fetchRepoInfo(
    username,
    repo,
    branch,
    path,
    true,
    token
  );

  // If we're up to date we just move the head, if that's not the cache we create
  // a merge
  if (lastInfo.commitSha === commitSha) {
    try {
      const res = await api.updateReference(
        username,
        repo,
        branch,
        commit.sha,
        token
      );

      ctx.body = {
        url: res.url,
        sha: commit.sha,
        merge: false
      };
      return;
    } catch (e) {
      if (process.env.NODE_ENV === "development") {
        console.error(e);
      }
      /* Let's try to create the merge then */
    }
  }

  try {
    const res = await api.createMerge(
      username,
      repo,
      branch,
      commit.sha,
      token
    );

    ctx.body = {
      url: res.url,
      sha: res.sha,
      merge: true
    };
    return;
  } catch (e) {
    if (e.response && e.response.status === 409) {
      // Merge conflict, create branch
      const res = await push.createBranch(gitInfo, commit.sha, token);

      ctx.body = {
        url: res.url,
        sha: commit.sha,
        newBranch: res.branchName
      };
      return;
    } else {
      throw e;
    }
  }
};

export const repo = async (ctx: Context, next: () => Promise<any>) => {
  const {
    token,
    normalizedFiles: fileArray,
    privateRepo
  }: {
    token: string;
    normalizedFiles: Array<IModule & { path: string }>;
    privateRepo?: boolean;
  } = ctx.request.body;
  const { username, repo } = ctx.params;

  const normalizedFiles: INormalizedModules = fileArray.reduce(
    (total, file) => ({
      ...total,
      [file.path]: file
    }),
    {}
  );

  if (!repo) {
    throw new Error("Repo name cannot be empty");
  }

  const result = await push.createRepo(
    username,
    repo,
    normalizedFiles,
    token,
    privateRepo
  );

  ctx.body = result;
};
