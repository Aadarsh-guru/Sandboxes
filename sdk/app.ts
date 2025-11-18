import { SandboxClient } from "./index";

interface SandboxConfig {
    cluster: string;
    subnets: string[];
    securityGroups: string[];
    taskDefinitions: Record<string, string>;
    defaultTimeout: number;
    secretKey: string;
}

const config: SandboxConfig = {
    cluster: "sandbox-cluster",
    subnets: [
        "subnet-0f3c27e86caf6afdf",
        "subnet-09c716921f949cca0",
        "subnet-0983c30fcc92be638",
    ],
    securityGroups: [
        "sg-04cacc5f6b79e4ba8",
        "sg-024d860fe5d7c38af",
    ],
    taskDefinitions: {
        WEB: "web-sandbox",
        MOBILE: "mobile-sandbox",
    },
    defaultTimeout: 10 * 60 * 1000,
    secretKey: "dzjvasq435t2734iuASDSGASdsfBSD",
};

function logStep(title: string, details?: unknown) {
    const message = `[${new Date().toISOString()}] ${title}`;
    if (details !== undefined) {
        console.log(message, details);
    } else {
        console.log(message);
    }
}

async function main() {
    const sandboxClient = new SandboxClient({
        cluster: config.cluster,
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        taskDefinitions: config.taskDefinitions,
        defaultTimeout: config.defaultTimeout,
        secretKey: config.secretKey,
    });

    logStep("Launching sandbox task");
    const taskArn = await sandboxClient.create({ type: "MOBILE" });
    logStep("Sandbox task created", taskArn);

    logStep("Connecting to sandbox");
    const sandbox = await sandboxClient.connect(taskArn);
    logStep("Connected", { sandboxId: sandbox.id, url: sandbox.url, privateIp: sandbox.privateIp, publicIp: sandbox.publicIp });

    logStep("Running test command");
    const commandResult = await sandbox.commands.run("echo 'Hello from SDK!'");
    logStep("Command result", commandResult);

    logStep("Running detached command (sleep 2)");
    await sandbox.commands.run("sleep 2 && echo 'Detached complete'", { detached: true });
    logStep("Detached command dispatched");

    const testDir = "tmp/sdk-demo";
    const testFile = `${testDir}/hello.txt`;
    const copiedFile = `${testDir}/hello-copy.txt`;
    const renamedFile = `${testDir}/hello-renamed.txt`;

    const fileContent = `Hello Sandbox! Timestamp: ${new Date().toISOString()}`;

    logStep("Creating demo directory");
    await sandbox.files.mkdir(testDir);

    logStep("Writing demo file");
    await sandbox.files.write(testFile, fileContent);

    logStep("Reading demo file");
    const readBack = await sandbox.files.read(testFile);
    logStep("File contents", readBack);

    logStep("Copying demo file");
    await sandbox.files.copy(testFile, copiedFile);

    logStep("Renaming copied file");
    await sandbox.files.rename(copiedFile, renamedFile);

    logStep("Listing directory");
    const listing = await sandbox.files.list(testDir);
    logStep("Directory listing", listing);

    logStep("File stats");
    const stats = await sandbox.files.stat(testFile);
    logStep("Stats", stats);

    logStep("Deleting demo files");
    await sandbox.files.delete(testFile);
    await sandbox.files.delete(renamedFile);

    logStep("Listing sandbox root");
    const rootListing = await sandbox.files.list("/");
    logStep("Root listing", rootListing);

    logStep("Removing demo directory");
    await sandbox.files.rmdir(testDir);

    logStep("Extending sandbox timeout by 5 minutes");
    await sandbox.extendTimeout(5 * 60 * 1000);
    logStep("Timeout extended");

    logStep("Stopping sandbox");
    await sandbox.stop();
    logStep("Sandbox stop requested");
}

main().catch((error) => {
    console.error("SDK demo failed", error);
    process.exitCode = 1;
});