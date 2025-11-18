import {
    ECSClient,
    RunTaskCommand,
    DescribeTasksCommand,
    type RunTaskCommandInput,
} from "@aws-sdk/client-ecs";
import { EC2Client, DescribeNetworkInterfacesCommand } from "@aws-sdk/client-ec2";

export interface SandboxCredentials {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
}

type SandboxTaskMap = Record<string, string>;

export interface SandboxClientOptions<TTaskMap extends SandboxTaskMap = SandboxTaskMap> {
    cluster: string;
    subnets: string[];
    secretKey: string;
    wildcardDomain?: string;
    securityGroups?: string[];
    taskDefinitions: TTaskMap;
    assignPublicIp?: boolean;
    defaultTimeout: number;
    credentials?: SandboxCredentials;
    launchType?: RunTaskCommandInput["launchType"];
}

export interface SandboxCreateParams<TTaskMap extends SandboxTaskMap = SandboxTaskMap> {
    type: keyof TTaskMap;
    timeout?: number;
}

interface SandboxParams {
    taskArn: string;
    url: string;
    privateIp: string;
    publicIp?: string | null;
    secretKey: string;
}

function resolveAwsConfig(credentials?: SandboxCredentials) {
    const region = credentials?.region ?? process.env["AWS_REGION"];
    const accessKeyId = credentials?.accessKeyId ?? process.env["AWS_ACCESS_KEY_ID"];
    const secretAccessKey = credentials?.secretAccessKey ?? process.env["AWS_SECRET_ACCESS_KEY"];

    if (!accessKeyId || !secretAccessKey || !region) {
        throw new Error(
            "Sandbox requires AWS credentials (accessKeyId, secretAccessKey, region) either passed in or available via environment variables with AWS_ prefix.",
        );
    }

    return {
        region,
        credentials: { accessKeyId, secretAccessKey },
    };
}

export class SandboxClient<TTaskMap extends SandboxTaskMap = SandboxTaskMap> {
    private readonly ecsClient: ECSClient;
    private readonly ec2Client: EC2Client;
    private readonly cluster: string;
    private readonly subnets: string[];
    private readonly wildcardDomain?: string;
    private readonly securityGroups?: string[];
    private readonly taskDefinitions: TTaskMap;
    private readonly assignPublicIp: boolean;
    private readonly launchType: RunTaskCommandInput["launchType"];
    private readonly defaultTimeout: number;
    private readonly secretKey: string;

    constructor(options: SandboxClientOptions<TTaskMap>) {
        const awsConfig = resolveAwsConfig(options.credentials);
        this.ecsClient = new ECSClient(awsConfig);
        this.ec2Client = new EC2Client(awsConfig);

        this.cluster = options.cluster;
        this.subnets = options.subnets;
        this.securityGroups = options.securityGroups;
        this.taskDefinitions = options.taskDefinitions;
        this.assignPublicIp = options.assignPublicIp ?? true;
        this.launchType = options.launchType ?? "FARGATE";
        this.wildcardDomain = options.wildcardDomain;
        this.defaultTimeout = options.defaultTimeout;
        this.secretKey = options.secretKey;
    }

    /**
     * Launches a sandbox task based on one of the configured task definitions.
     * Returns the ARN immediately after ECS accepts the run request.
     */
    async create({ type, timeout }: SandboxCreateParams<TTaskMap>): Promise<string> {
        const taskDefinition = this.taskDefinitions[type as keyof TTaskMap];

        if (!taskDefinition) {
            throw new Error(`Unknown sandbox type: ${String(type)}`);
        }

        const effectiveTimeout = timeout ?? this.defaultTimeout;
        const containerName = taskDefinition;

        const runTaskCommand = new RunTaskCommand({
            cluster: this.cluster,
            taskDefinition,
            launchType: this.launchType,
            networkConfiguration: {
                awsvpcConfiguration: {
                    subnets: this.subnets,
                    securityGroups: this.securityGroups,
                    assignPublicIp: this.assignPublicIp ? "ENABLED" : "DISABLED",
                },
            },
            overrides: {
                containerOverrides: [
                    {
                        name: containerName,
                        environment: [
                            { name: "SANDBOX_API_KEY", value: this.secretKey },
                            { name: "SANDBOX_TIMEOUT", value: String(effectiveTimeout) },
                        ],
                    },
                ],
            },
        });

        const runTaskResponse = await this.ecsClient.send(runTaskCommand);
        const taskArn = runTaskResponse.tasks?.[0]?.taskArn;

        if (!taskArn) {
            throw new Error("Failed to launch sandbox.");
        }

        return taskArn;
    }

    /**
     * Connects to a sandbox by polling ECS/ENI in parallel until the task is running
     * and required network IPs are assigned, returning immediately when ready.
     */
    async connect(taskArn: string, subdomain?: string): Promise<Sandbox> {
        const requiresPublicIp = !this.wildcardDomain;

        if (this.wildcardDomain && !subdomain) {
            throw new Error("subdomain is required when wildcardDomain is configured");
        }

        const maxAttempts = 30;
        const intervalMs = 1000;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Describe ECS task (must always be done)
            const taskResult = await this.ecsClient.send(
                new DescribeTasksCommand({ cluster: this.cluster, tasks: [taskArn] })
            );

            const task = taskResult.tasks?.[0] ?? null;
            if (!task) throw new Error(`Sandbox task ${taskArn} not found.`);

            // Stop handling
            if (task.lastStatus === "STOPPED") {
                const reason = task.stoppedReason || "Sandbox stopped unexpectedly.";
                const err: any = new Error(reason);
                err.statusCode = 410;
                throw err;
            }

            // Must get all containers running (not necessarily healthy)
            const containers = task.containers ?? [];
            const allRunning = containers.every(c => c.lastStatus === "RUNNING");
            if (!allRunning) {
                await new Promise(r => setTimeout(r, intervalMs));
                continue;
            }

            // Extract ENI + private IP
            const eni = task.attachments?.find(a => a.type === "ElasticNetworkInterface");
            const eniId =
                eni?.details?.find(d => d.name === "networkInterfaceId")?.value ?? null;

            const privateIp =
                eni?.details?.find(d => d.name === "privateIPv4Address")?.value ??
                containers[0]?.networkInterfaces?.[0]?.privateIpv4Address ??
                null;

            // Fast lookup for public IP (if present already)
            let publicIp =
                eni?.details?.find(d => d.name === "publicIPv4Address")?.value ?? null;

            // 🚀 PARALLEL FETCH (if needed) -------------------------------------------------
            let publicIpPromise: Promise<string | null> | null = null;

            if (requiresPublicIp && !publicIp && eniId) {
                publicIpPromise = this.ec2Client
                    .send(new DescribeNetworkInterfacesCommand({
                        NetworkInterfaceIds: [eniId]
                    }))
                    .then(res => res.NetworkInterfaces?.[0]?.Association?.PublicIp ?? null)
                    .catch(() => null);
            }
            // ------------------------------------------------------------------------------

            // SUCCESS CONDITIONS
            if (privateIp) {
                if (requiresPublicIp) {
                    // If fast public IP not found, await the parallel lookup
                    if (!publicIp && publicIpPromise) {
                        publicIp = await publicIpPromise;
                    }
                    if (publicIp) {
                        const url = `http://${publicIp}`;
                        return new Sandbox({
                            taskArn,
                            url,
                            privateIp,
                            publicIp,
                            secretKey: this.secretKey,
                        });
                    }
                } else {
                    const url = `https://${subdomain}.${this.wildcardDomain}`;
                    return new Sandbox({
                        taskArn,
                        url,
                        privateIp,
                        publicIp: null,
                        secretKey: this.secretKey,
                    });
                }
            }

            // retry
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        throw new Error("Sandbox failed to start within 30 seconds.");
    }

}

interface SandboxCommandRunOptions {
    args?: string[];
    cwd?: string;
    detached?: boolean;
}

interface SandboxCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    events: { event: string; payload: unknown }[];
}

interface SandboxFsListResult {
    files: string[];
}

interface SandboxFsStatResult {
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    createdAt: string | Date;
    modifiedAt: string | Date;
}

interface SandboxFsResponse<T> {
    success: boolean;
    data: T;
    error?: string;
}

export class Sandbox {
    public readonly id: string;
    public readonly url: string;
    public readonly privateIp: string;
    public readonly publicIp: string | null | undefined;
    public readonly commands: SandboxCommands;
    public readonly files: SandboxFiles;

    private readonly secretKey: string;

    constructor(params: SandboxParams) {
        this.url = params.url.replace(/\/$/, "");
        this.id = params.taskArn;
        this.publicIp = params.publicIp ?? null;
        this.privateIp = params.privateIp;
        this.secretKey = params.secretKey;

        this.commands = new SandboxCommands(this);
        this.files = new SandboxFiles(this);
    }

    async fetch(path: string, init: RequestInit = {}) {
        const headers = new Headers(init.headers ?? {});
        if (!headers.has("Authorization")) {
            headers.set("Authorization", `Bearer ${this.secretKey}`);
        }
        if (init.body && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }
        const url = `${this.url}${path}`;
        return fetch(url, { ...init, headers });
    }

    async extendTimeout(durationMs?: number) {
        await this.fetch("/extend-timeout", {
            method: "POST",
            body: JSON.stringify({ durationMs }),
        });
    }

    async stop() {
        await this.fetch("/stop", { method: "POST" });
    }
}

class SandboxCommands {
    constructor(private readonly sandbox: Sandbox) { }

    async run(command: string, options: SandboxCommandRunOptions = {}): Promise<SandboxCommandResult> {
        const response = await this.sandbox.fetch("/exec", {
            method: "POST",
            body: JSON.stringify({
                command,
                args: options.args ?? [],
                cwd: options.cwd,
                detached: options.detached ?? false,
            }),
        });

        if (!response.ok || !response.body) {
            throw new Error(`Sandbox command failed with status ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let stdout = "";
        let stderr = "";
        let exitCode: number | null = null;
        const events: SandboxCommandResult["events"] = [];

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    events.push(parsed);
                    switch (parsed.event) {
                        case "stdout":
                            stdout += parsed.payload ?? "";
                            break;
                        case "stderr":
                            stderr += parsed.payload ?? "";
                            break;
                        case "exit":
                            exitCode = parsed.payload?.exitCode ?? null;
                            break;
                        default:
                            break;
                    }
                } catch (error) {
                    // Ignore malformed chunks but keep consuming stream
                    console.error("Failed to parse sandbox command chunk", error);
                }
            }
        }

        return { stdout, stderr, exitCode, events };
    }
}

class SandboxFiles {
    constructor(private readonly sandbox: Sandbox) { }

    async read(path: string) {
        return this.callFs<string>({ action: "readFile", path });
    }

    async write(path: string, content: string) {
        await this.callFs({ action: "writeFile", path, content });
    }

    async delete(path: string) {
        await this.callFs({ action: "deleteFile", path });
    }

    async mkdir(path: string) {
        await this.callFs({ action: "mkdir", path });
    }

    async rmdir(path: string) {
        await this.callFs({ action: "rmdir", path });
    }

    async rename(path: string, targetPath: string) {
        await this.callFs({ action: "rename", path, targetPath });
    }

    async copy(path: string, targetPath: string) {
        await this.callFs({ action: "copyFile", path, targetPath });
    }

    async list(path: string = "/") {
        return this.callFs<SandboxFsListResult>({ action: "ls", path });
    }

    async stat(path: string) {
        return this.callFs<SandboxFsStatResult>({ action: "stat", path });
    }

    private async callFs<T = unknown>(payload: { action: string; path: string; content?: string; targetPath?: string }) {
        const response = await this.sandbox.fetch("/fs", {
            method: "POST",
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Sandbox FS request failed with status ${response.status}`);
        }

        const json = (await response.json()) as SandboxFsResponse<T>;
        if (!json.success) {
            throw new Error(json.error ?? "Sandbox FS action failed");
        }

        return json.data;
    }
}