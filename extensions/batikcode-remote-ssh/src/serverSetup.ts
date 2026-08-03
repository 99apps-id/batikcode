import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Log } from './common/logger';
import { getVSCodeServerConfig, ServerVersion, ServerValidation } from './serverConfig';
import SSHConnection from './ssh/sshConnection';
import { fetchRelease, IRelease } from './fetchRelease';
import * as semver from 'semver';
import * as os from 'os';

/**
 * Reads a script template from <extensionPath>/scripts/<templateName> and
 * replaces every %%KEY%% occurrence with the matching value from `variables`.
 */
function compileTemplate(templateName: string, variables: Record<string, string>, extensionPath: string): string {
    const templatePath = path.join(extensionPath, 'src', 'scripts', templateName);
    let content = fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');
    for (const [key, value] of Object.entries(variables)) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        content = content.replace(new RegExp(`%%${escapedKey}%%`, 'g'), value);
    }
    return content;
}

/**
 * Matches a hostname against a pattern that may contain wildcards.
 * Returns a specificity score: higher scores indicate more specific matches.
 * Returns -1 if no match.
 */
function matchHostnamePattern(hostname: string, pattern: string): number {
    // Exact match has highest priority
    if (hostname === pattern) {
        return 1000;
    }

    // Catch-all wildcard has lowest priority
    if (pattern === '*') {
        return 1;
    }

    // Convert wildcard pattern to regex
    // Escape special regex characters except *
    const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(hostname)) {
        // Calculate specificity based on the number of non-wildcard characters
        // More specific patterns (more characters) get higher scores
        const nonWildcardChars = pattern.replace(/\*/g, '').length;
        return 10 + nonWildcardChars;
    }

    return -1;
}

/**
 * Finds the best matching path for a hostname from a map of patterns to paths.
 * Supports wildcards with priority: exact match > specific wildcard > general wildcard.
 */
export function findServerInstallPath(hostname: string, pathMap: Record<string, string>): string | undefined {
    let bestMatch: { pattern: string; path: string; score: number } | undefined;

    for (const [pattern, path] of Object.entries(pathMap)) {
        const score = matchHostnamePattern(hostname, pattern);

        if (score > 0) {
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { pattern, path, score };
            }
        }
    }

    return bestMatch?.path;
}

export type ServerInstallOptions = {
    id: string;
    quality: string;
    commit: string;
    version: string;
    release?: string;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
    customInstallPath?: string;
    serverValidation: ServerValidation;
};

export type ServerInstallResult = {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: unknown;
};

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

function prepareExtensionsTarball(extensionPath: string, platform: string, logger: Log): string {
    const cachedTarball = path.join(os.tmpdir(), `batikcode-extensions-${platform}.tar.gz`);
    // Building this means walking ~78k files under extensions/copilot with a
    // synchronous copy, which blocks the extension host for minutes. It only
    // changes when the extensions are rebuilt, so it is cached against the
    // manifest each bundle is written beside.
    const bundleInputs = [
        path.resolve(extensionPath, '..', 'copilot', 'package.json'),
        path.resolve(extensionPath, '..', 'copilot', 'dist', 'extension.js'),
        path.resolve(extensionPath, '..', 'batikcode-provider-hub', 'package.json'),
        path.resolve(extensionPath, '..', 'batikcode-provider-hub', 'out', 'extension.js'),
    ];
    if (!bundleInputs.some(input => isTarballStale(cachedTarball, input))) {
        logger.trace(`Reusing cached extensions tarball at ${cachedTarball}`);
        return cachedTarball;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batikcode-ext-'));
    const copilotDest = path.join(tempDir, 'github.copilot-chat');
    const hubDest = path.join(tempDir, 'batikcode.batikcode-provider-hub');

    logger.trace(`Preparing temporary extensions directory at ${tempDir}`);
    fs.mkdirSync(copilotDest, { recursive: true });
    fs.mkdirSync(hubDest, { recursive: true });

    const localCopilotPath = path.resolve(extensionPath, '..', 'copilot');
    const localHubPath = path.resolve(extensionPath, '..', 'batikcode-provider-hub');

    const filterExt = (src: string) => {
        const basename = path.basename(src);
        if (['.git', 'test', 'tests', 'docs', '.build', '.vscode', '.github'].includes(basename)) {
            return false;
        }

        // `src` is the TypeScript the bundle was built from — 40MB the remote
        // never loads.
        if (basename === 'src') {
            return false;
        }

        // The extension's own .vscodeignore keeps these out of a real package;
        // this hand-rolled copy has to exclude them too, or every connection
        // ships ~160MB of test harnesses and source maps.
        if (basename.endsWith('.map') || /^(sanity-)?test-extension\.js$|^simulationMain\.js$/.test(basename)) {
            return false;
        }

        const parts = src.split(/[\\/]node_modules[\\/]/);
        if (parts.length > 1) {
            const relativeToNodeModules = parts[parts.length - 1];
            const firstDir = relativeToNodeModules.split(/[\\/]/)[0];
            if (firstDir && firstDir !== '@github' && firstDir !== '@vscode' && firstDir !== '.bin') {
                return false;
            }
        }

        if ((platform === 'linux' || platform === 'alpine') && src.includes('win32-')) {
            return false;
        }
        if (platform !== 'darwin' && src.includes('darwin-')) {
            return false;
        }
        if (platform !== 'linux' && platform !== 'alpine' && src.includes('linux-')) {
            return false;
        }

        return true;
    };

    logger.trace(`Copying copilot extension from ${localCopilotPath} to ${copilotDest}`);
    try {
        fs.cpSync(localCopilotPath, copilotDest, { 
            recursive: true,
            filter: filterExt
        });
    } catch (err: any) {
        logger.trace(`Warning: Error copying copilot extension (${err.message}). Trying to continue...`);
    }
    
    logger.trace(`Copying provider-hub extension from ${localHubPath} to ${hubDest}`);
    try {
        fs.cpSync(localHubPath, hubDest, { 
            recursive: true,
            filter: filterExt
        });
    } catch (err: any) {
        logger.trace(`Warning: Error copying provider-hub extension (${err.message}). Trying to continue...`);
    }

    const tarballPath = cachedTarball;
    logger.trace(`Compressing extensions to ${tarballPath}`);
    if (fs.existsSync(tarballPath)) {
        try {
            fs.unlinkSync(tarballPath);
        } catch {}
    }
    
    // Run tar command
    execSync(`tar -czf "${tarballPath}" -C "${tempDir}" .`, { stdio: 'ignore' });

    // Clean up tempDir
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    return tarballPath;
}

/** Builds the small Provider Hub payload independently from the Copilot bundle. */
function prepareProviderHubTarball(extensionPath: string, logger: Log): string {
    const cachedTarball = path.join(os.tmpdir(), 'batikcode-provider-hub.tar.gz');
    const localHubPath = path.resolve(extensionPath, '..', 'batikcode-provider-hub');
    const bundleInputs = [
        path.join(localHubPath, 'package.json'),
        path.join(localHubPath, 'out', 'extension.js'),
    ];
    if (!bundleInputs.some(input => isTarballStale(cachedTarball, input))) {
        logger.trace(`Reusing cached Provider Hub tarball at ${cachedTarball}`);
        return cachedTarball;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batikcode-provider-hub-'));
    const hubDest = path.join(tempDir, 'batikcode.batikcode-provider-hub');
    fs.mkdirSync(hubDest, { recursive: true });
    fs.copyFileSync(path.join(localHubPath, 'package.json'), path.join(hubDest, 'package.json'));
    fs.cpSync(path.join(localHubPath, 'out'), path.join(hubDest, 'out'), { recursive: true });
    const mediaPath = path.join(localHubPath, 'media');
    if (fs.existsSync(mediaPath)) {
        fs.cpSync(mediaPath, path.join(hubDest, 'media'), { recursive: true });
    }

    try {
        execSync(`tar -czf "${cachedTarball}" -C "${tempDir}" .`, { stdio: 'ignore' });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return cachedTarball;
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

/**
 * Maps the machine field of `uname -m` (or the trailing field of `uname -sm`)
 * to the architecture slug used in server build folder names and download URLs.
 * Returns undefined when the architecture is unknown to us.
 */
function serverArchFromUname(uname: string | undefined): string | undefined {
    const machine = (uname || '').trim().split(/\s+/).pop()?.toLowerCase();
    switch (machine) {
        case 'x86_64':
        case 'amd64':
            return 'x64';
        case 'arm64':
        case 'aarch64':
            return 'arm64';
        case 'armv7l':
        case 'armv8l':
            return 'armhf';
        case 'ppc64le':
            return 'ppc64le';
        case 'riscv64':
            return 'riscv64';
        case 's390x':
            return 's390x';
        case 'loongarch64':
            return 'loong64';
        default:
            return undefined;
    }
}

/** A locally built BatikCode server (REH) that can be shipped to the remote over SFTP. */
type LocalServerBuild = {
    readonly directory: string;
    readonly commit: string;
    readonly version: string;
};

/**
 * Locates the `vscode-reh-<platform>-<arch>` folder that
 * `npm run gulp vscode-reh-<platform>-<arch>` writes next to the repository, and
 * reads the identity it was stamped with. While no BatikCode server release is
 * published, shipping this build is the only way a client reaches a matching
 * server.
 */
function resolveLocalServerBuild(extensionPath: string, platform: string, arch: string, logger: Log): LocalServerBuild | undefined {
    const directory = path.resolve(extensionPath, '..', '..', '..', `vscode-reh-${platform}-${arch}`);
    if (!fs.existsSync(directory)) {
        logger.trace(`No local server build at ${directory}.`);
        return undefined;
    }

    let commit = '';
    let version = '';
    try {
        const productJson = JSON.parse(fs.readFileSync(path.join(directory, 'product.json'), 'utf8'));
        commit = productJson.commit || '';
        version = productJson.version || '';
    } catch (err: any) {
        logger.trace(`Local server build at ${directory} has no readable product.json: ${err.message}`);
    }

    if (!commit) {
        // A development build carries no commit. Derive a stable identity from
        // the build folder itself so that rebuilding produces a new remote
        // install directory instead of silently reusing the previous server.
        commit = `dev-${fs.statSync(directory).mtimeMs.toString(36)}`;
    }

    logger.trace(`Using local server build ${directory} (commit ${commit}).`);
    return { directory, commit, version };
}

/** True when the tarball is missing or older than the build folder it was made from. */
function isTarballStale(tarballPath: string, buildDirectory: string): boolean {
    try {
        return fs.statSync(tarballPath).mtimeMs < fs.statSync(buildDirectory).mtimeMs;
    } catch {
        return true;
    }
}

export async function installCodeServer(
    conn: SSHConnection,
    serverDownloadUrlTemplate: string | undefined,
    serverVersion: ServerVersion,
    extensionIds: string[],
    envVariables: string[],
    platform: string | undefined,
    useSocketPath: boolean,
    customInstallPath: string | undefined,
    logger: Log,
    extensionPath: string
): Promise<ServerInstallResult> {
    let shell = 'powershell';
    let unameOutput: string | undefined;

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        // `-m` rides along with the platform probe: the remote machine field is
        // the only reliable source for the server architecture, and asking for
        // it here avoids a second round trip.
        const result = await conn.exec('uname -sm');

        unameOutput = (result.stdout || '').trim();
        const stdout = unameOutput.toLowerCase();
        const stderr = (result.stderr || '').trim().toLowerCase();

        if (stdout.includes('windows32') || stdout.includes('mingw') || stdout.includes('msys') || stdout.includes('cygwin')) {
            platform = 'windows';
            shell = 'bash';
        } else if (stdout.includes('linux')) {
            platform = 'linux';
            const osRelease = await conn.exec('cat /etc/os-release');
            if (osRelease.stdout && (osRelease.stdout.includes('ID=alpine') || osRelease.stdout.includes('ID_LIKE=alpine'))) {
                platform = 'alpine';
            }
        } else if (stdout.includes('darwin')) {
            platform = 'darwin';
        } else if (stderr.includes('commandnotfoundexception') || stderr.includes('is not recognized')) {
            platform = 'windows';
            shell = 'cmd';
        } else {
            // Fallback to linux if we don't recognize the output or if uname is missing but not recognized as Windows cmd/powershell
            platform = 'linux';
        }

        if (platform) {
            logger.trace(`Detected platform: ${platform}, ${shell}`);
        }
    }

    const scriptId = crypto.randomBytes(12).toString('hex');

    const vscodeServerConfig = await getVSCodeServerConfig();

    let remoteArch = serverArchFromUname(unameOutput);
    if (!remoteArch && platform !== 'windows') {
        remoteArch = serverArchFromUname((await conn.exec('uname -m')).stdout);
    }
    remoteArch = remoteArch || 'x64';
    logger.trace(`Remote architecture: ${remoteArch}`);

    const localServer = resolveLocalServerBuild(extensionPath, platform!, remoteArch, logger);

    let resolvedServerVersion = serverVersion;
    if (!localServer && !vscodeServerConfig.commit) {
        // Without a local build and without a commit there is nothing to match a
        // published server against, so take whatever the release feed offers.
        resolvedServerVersion = 'latest';
    }

    // Get the version and release
    let configuredDownloadUrlTemplate = serverDownloadUrlTemplate || vscodeServerConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE;
    let bestRelease: IRelease = await fetchRelease(configuredDownloadUrlTemplate, vscodeServerConfig.version, vscodeServerConfig.release, resolvedServerVersion, logger);

    if (!bestRelease.matched && configuredDownloadUrlTemplate !== DEFAULT_DOWNLOAD_URL_TEMPLATE) {
        // The configured repository published nothing usable. Substituting a
        // version from elsewhere into its URL only produces a 404, so switch the
        // whole template over rather than mixing the two.
        logger.info(`Configured server download repository has no usable release; falling back to ${DEFAULT_DOWNLOAD_URL_TEMPLATE}`);
        configuredDownloadUrlTemplate = DEFAULT_DOWNLOAD_URL_TEMPLATE;
        bestRelease = await fetchRelease(configuredDownloadUrlTemplate, vscodeServerConfig.version, vscodeServerConfig.release, resolvedServerVersion, logger);
    }

    // Format the download URL template dynamically by substituting version and release,
    // taking into account the VSCodium fused version format for >= 1.99.0.
    const isFused = semver.satisfies(bestRelease.version, '>=1.99.0');
    const versionReleaseStr = isFused ? `${bestRelease.version}${bestRelease.build}` : `${bestRelease.version}.${bestRelease.build}`;

    const serverDownloadUrlTemplateFinal = configuredDownloadUrlTemplate
        .replace(/\$\{version\}\.\$\{release\}/g, versionReleaseStr)
        .replace(/\$\{version\}\$\{release\}/g, versionReleaseStr)
        .replace(/\$\{version\}/g, bestRelease.version)
        .replace(/\$\{release\}/g, bestRelease.build);

    // Ship the locally built server whenever one exists. It is the only build
    // that matches this client, so it takes precedence over any release feed.
    let uploadedLocalServer = false;
    if (localServer) {
        const remoteDataDir = customInstallPath
            ? customInstallPath.replace(/^~(?=\/|$)/, '$HOME')
            : `$HOME/${vscodeServerConfig.serverDataFolderName}`;
        const remoteServerScript = `${remoteDataDir}/bin/${localServer.commit}/bin/${vscodeServerConfig.serverApplicationName}`;
        const escapedRemoteServerScript = remoteServerScript.replace(/(["\\`])/g, '\\$1');
        const installedResult = platform !== 'windows'
            ? await conn.exec(`[ -f "${escapedRemoteServerScript}" ] && echo "exists"`)
            : undefined;
        const alreadyInstalled = (installedResult?.stdout || '').trim() === 'exists';

        if (alreadyInstalled) {
            uploadedLocalServer = true;
            logger.trace(`Matching local server build is already installed at ${remoteServerScript}; skipping upload.`);
        } else {
            const localTarballPath = path.resolve(extensionPath, '..', '..', '..', 'batikcode-server.tar.gz');
            try {
                if (isTarballStale(localTarballPath, localServer.directory)) {
                    logger.trace(`Compressing ${localServer.directory} to ${localTarballPath}`);
                    execSync(`tar -czf "${localTarballPath}" -C "${localServer.directory}" .`, { stdio: 'ignore' });
                } else {
                    logger.trace(`Reusing up-to-date server tarball at ${localTarballPath}`);
                }
                logger.trace(`Uploading ${localTarballPath} to remote batikcode-server.tar.gz via SFTP...`);
                const sftp = await conn.sftp();
                await new Promise<void>((resolve, reject) => {
                    sftp.fastPut(localTarballPath, 'batikcode-server.tar.gz', (err: any) => {
                        if (err) { reject(err); } else { resolve(); }
                    });
                });
                uploadedLocalServer = true;
                logger.trace(`Upload complete.`);
            } catch (err: any) {
                logger.trace(`Failed to ship the local server build (${err.message}). Remote will fall back to downloading.`);
            }
        }
    } else {
        logger.info(
            `No local server build for ${platform}-${remoteArch} was found next to the repository. ` +
            `Falling back to downloading ${serverDownloadUrlTemplateFinal}, which is not a BatikCode build and may not match this client. ` +
            `Run "npm run gulp vscode-reh-${platform}-${remoteArch}" to build a matching server.`
        );
    }

    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: localServer?.version || bestRelease.version,
        // Keys the remote install directory. Using the shipped build's own
        // identity means a rebuilt server installs alongside — rather than
        // behind — a previously installed one.
        commit: (uploadedLocalServer ? localServer!.commit : vscodeServerConfig.commit) || `dev-${vscodeServerConfig.version}`,
        quality: vscodeServerConfig.quality,
        release: bestRelease.build,
        extensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: serverDownloadUrlTemplateFinal,
        customInstallPath,
        // A shipped local build already matches the client, so honour the user's
        // setting. Anything else is a foreign build whose commit must be
        // rewritten for the handshake to succeed.
        serverValidation: uploadedLocalServer ? vscodeServerConfig.serverValidation : 'force',
    };

    // Upload custom extensions when the remote copy is missing or stale. Merely
    // checking that its directory exists permanently pinned Remote SSH hosts to
    // the first Provider Hub manifest they received (including extensionKind=ui).
    try {
        const localHubManifestPath = path.resolve(extensionPath, '..', 'batikcode-provider-hub', 'package.json');
        const localHubManifest = JSON.parse(fs.readFileSync(localHubManifestPath, 'utf8')) as { version?: string; extensionKind?: string[] };
        const remoteDataDir = customInstallPath
            ? customInstallPath.replace(/^~(?=\/|$)/, '$HOME')
            : `$HOME/${vscodeServerConfig.serverDataFolderName}`;
        const escapedRemoteDataDir = remoteDataDir.replace(/(["\\`])/g, '\\$1');
        const remoteExtensionsDir = `${escapedRemoteDataDir}/extensions`;
        const copilotMarker = '__BATIKCODE_COPILOT_PRESENT__';
        const checkResult = await conn.exec(
            `[ -d "${remoteExtensionsDir}/github.copilot-chat" ] && echo "${copilotMarker}"; ` +
            `cat "${remoteExtensionsDir}/batikcode.batikcode-provider-hub/package.json" 2>/dev/null`
        );
        const remoteOutput = (checkResult.stdout || '').trim();
        const copilotPresent = remoteOutput.split(/\r?\n/).includes(copilotMarker);
        const remoteManifestText = remoteOutput
            .split(/\r?\n/)
            .filter(line => line !== copilotMarker)
            .join('\n');
        let remoteHubManifest: { version?: string; extensionKind?: string[] } | undefined;
        try {
            remoteHubManifest = JSON.parse(remoteManifestText);
        } catch {
            // Missing or malformed manifests are replaced below.
        }
        const remoteHubIsCurrent = remoteHubManifest?.version === localHubManifest.version
            && remoteHubManifest?.extensionKind?.[0] === 'workspace';

        if (copilotPresent && remoteHubIsCurrent) {
            logger.trace(`Remote custom extensions are current (Provider Hub ${localHubManifest.version}).`);
        } else if (copilotPresent) {
            const providerHubTarball = prepareProviderHubTarball(extensionPath, logger);
            logger.trace(`Uploading Provider Hub ${localHubManifest.version} update via SFTP...`);
            const sftp = await conn.sftp();
            await new Promise<void>((resolve, reject) => {
                sftp.fastPut(providerHubTarball, 'batikcode-provider-hub.tar.gz', (err: Error | undefined) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
            logger.trace(`Provider Hub update upload complete.`);
        } else {
            const localExtTarball = prepareExtensionsTarball(extensionPath, platform || 'linux', logger);
            if (fs.existsSync(localExtTarball)) {
                logger.trace(`Uploading custom extensions from ${localExtTarball} via SFTP...`);
                const sftp = await conn.sftp();
                await new Promise<void>((resolve, reject) => {
                    sftp.fastPut(localExtTarball, 'batikcode-extensions.tar.gz', (err: any) => {
                        if (err) reject(err); else resolve();
                    });
                });
                logger.trace(`Custom extensions upload complete.`);
                // Deliberately kept: rebuilding it costs a multi-minute walk of
                // the extensions tree, and the next host can reuse this one.
            }
        }
    } catch (extErr: any) {
        logger.trace(`Notice: Could not upload custom extensions via SFTP (${extErr.message}). Server setup will continue.`);
    }

    const endRegex = new RegExp(`${scriptId}: end`);
    let commandOutput: { stdout: string; stderr: string };
    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions, extensionPath);

        logger.trace('Server install command:', installServerScript);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;

        // investigate if it's possible to use `-EncodedCommand` flag
        // https://devblogs.microsoft.com/powershell/invoking-powershell-with-complex-expressions-using-scriptblocks/
        // eslint-disable-next-line no-useless-assignment
        let command = '';

        if (shell === 'powershell') {
            command = `md -Force ${installDir}; echo @'\n${installServerScript}\n'@ | Set-Content ${installScript}; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p ${installDir.replace(/\\/g, '/')} && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > ${installScript.replace(/\\/g, '/')} && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            const script = installServerScript.trim()
                // remove comments
                .replace(/^#.*$/gm, '')
                // remove empty lines
                .replace(/\n{2,}/gm, '\n')
                // remove leading spaces
                .replace(/^\s*/gm, '')
                // escape double quotes (from powershell/cmd)
                .replace(/"/g, '"""')
                // escape single quotes (from cmd)
                .replace(/'/g, `''`)
                // escape redirect (from cmd)
                .replace(/>/g, `^>`)
                // escape new lines (from powershell/cmd)
                .replace(/\n/g, '\'`n\'');

            command = `powershell "md -Force ${installDir}" && powershell "echo '${script}'" > ${installScript.replace('$HOME', '%USERPROFILE%')} && powershell -ExecutionPolicy ByPass -File "${installScript.replace('$HOME', '%USERPROFILE%')}"`;

            logger.trace('Command length (8191 max):', command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        commandOutput = await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {
        const installServerScript = generateBashInstallScript(installOptions, extensionPath);

        logger.trace('Server install command:', installServerScript);
        // Use base64 encoding to avoid shell quoting issues across different login shells (bash, csh, tcsh, fish).
        // csh cannot handle multi-line strings inside single quotes with -c, so piping via base64 is the most portable approach.
        const base64Script = Buffer.from(installServerScript).toString('base64');
        commandOutput = await conn.execPartial(`echo ${base64Script} | base64 -d | bash -l`, (stdout: string) => endRegex.test(stdout));
    }

    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output. Stdout: ${commandOutput.stdout.substring(0, 1000)}. Stderr: ${commandOutput.stderr.substring(0, 1000)}`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status (${exitCode}). Stdout: ${commandOutput.stdout.substring(0, 1000)}. Stderr: ${commandOutput.stderr.substring(0, 1000)}`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }

    return resultMap;
}

function generateBashInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=\/|$)/, '$HOME')
        : `$HOME/${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `  echo "${envVar}==$${envVar}=="`).join('\n');

    return compileTemplate('server-setup.sh', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir="$SERVER_DATA_DIR"' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL_TEMPLATE: serverDownloadUrlTemplate.replace(/\$\{/g, '\\${'),
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? 'true' : 'false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
    }, extensionPath);
}

function generatePowerShellInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=[\\/]|$)/, '$(Resolve-Path ~)')
        : `$(Resolve-Path ~)\\${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `    "$${envVar}==$${envVar}=="`).join('\n');

    return compileTemplate('server-setup.ps1', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir=""$SERVER_DATA_DIR""' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL: downloadUrl,
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? '$true' : '$false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
    }, extensionPath);
}
