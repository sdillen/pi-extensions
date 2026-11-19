// ---------------------------------------------------------------------------
// SSH context for the system prompt
//
// Pi builds the prompt from structured sections (systemPromptOptions).
// We mutate these in place: `cwd` points to the remote directory, and a
// dedicated `ssh_remote` section tells the agent that it runs on a remote host.
// Pure logic without a pi dependency – hence directly testable.
// ---------------------------------------------------------------------------

import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export const SSH_REMOTE_SECTION = "ssh_remote";

export interface SshTarget {
	remote: string;
	remoteCwd: string;
}

export function sshRemoteSection({ remote, remoteCwd }: SshTarget): string {
	return [
		"You are running on a remote host over SSH, not on the local machine.",
		`- Host: ${remote}`,
		`- Working directory: ${remoteCwd}`,
		'- The read, write, edit, and bash tools and "!" commands execute on this host. Local files are not accessible.',
		"- Use paths on the remote host. Relative paths resolve against the working directory above.",
		"- For commands that need root, use the sudo tool. The bash tool rejects sudo on this host.",
	].join("\n");
}

export function applySshContext(
	options: Pick<NormalizedBuildSystemPromptOptions, "cwd" | "sections">,
	target: SshTarget,
): void {
	options.cwd = target.remoteCwd;
	options.sections[SSH_REMOTE_SECTION] = sshRemoteSection(target);
}
