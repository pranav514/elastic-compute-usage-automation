  import {
    CostExplorerClient,
    GetCostAndUsageCommand,
  } from "@aws-sdk/client-cost-explorer";
  import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
  import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
  import { stringify } from "csv-stringify/sync";
  import * as dotenv from "dotenv";

  dotenv.config();

  const s3 = new S3Client({});
  const ce = new CostExplorerClient({});
  const ses = new SESv2Client({});

  const BUCKET = process.env.BUCKET;
  const SES_FROM = process.env.SES_FROM;
  const SES_TO = process.env.SES_TO?.split(",").map((email) => email.trim()) || [];


  const VCPUS = {
    "t2.micro": 1,
    "t2.small": 1,
    "t2.medium": 2,
    "t2.large": 2,
    "c5.large": 2,
    "c5.xlarge": 4,
    "c5.2xlarge": 8,
    "c5.4xlarge": 16,
    "c5.9xlarge": 36,
    "c5.18xlarge": 72,
    "g4dn.xlarge": 4,
    "g4dn.2xlarge": 8,
    "g4dn.4xlarge": 16,
    "g5.xlarge": 4,
    "g5.2xlarge": 8,
    "g5.4xlarge": 16,
  };

  // Validate required environment variables
  const validateEnvironment = () => {
    const required = ["BUCKET", "SES_FROM", "SES_TO"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`
      );
    }
  };

  export const handler = async () => {
    try {
      console.log("Starting EC2 usage report generation...");

      // Validate environment variables
      validateEnvironment();
      console.log("Environment variables validated successfully");

      // Calculate date range - FIXED DATE CALCULATION
      const today = new Date();
      console.log("today", today);
      const currentYear = today.getFullYear();
      const currentMonth = today.getMonth() + 1; // 0-indexed (0 = January, 11 = December)
      console.log("currentMonth", currentMonth);
      // Calculate previous month and year
      let prevMonth, prevYear;
      if (currentMonth === 1) {
        // If current month is January, previous month is December of previous year
        prevMonth = 12; // December
        prevYear = currentYear - 1;
      } else {
        prevMonth = currentMonth - 1;
        prevYear = currentYear;
      }


      console.log("prevyear", prevYear);
      console.log("prevMonth", prevMonth);
      const lastDayLastMonth = new Date(prevYear, prevMonth, 1); // Day 0 of next month = last day of current month
      console.log("lastDayLastMonth", lastDayLastMonth);
      const prevMonthStr = prevMonth.toString().padStart(2, "0");
      const start = `${prevYear}-${prevMonthStr}-01`;
      const end = lastDayLastMonth.toISOString().split("T")[0];

      console.log(`Fetching usage data from ${start} to ${end}`);

      // Fetch usage data with error handling
      let response; 
      try {
        response = await ce.send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: start, End: end },
            Granularity: "MONTHLY",
            Metrics: ["UsageQuantity"],
            Filter: {
              And: [
                {
                  Dimensions: {
                    Key: "SERVICE",
                    Values: ["Amazon Elastic Compute Cloud - Compute"],
                  },
                },
                { Dimensions: { Key: "REGION", Values: ["ap-south-1"] } },
              ],
            },
            GroupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }],
          })
        );

        console.log("Cost Explorer data fetched successfully");
      } catch (error) {
        console.error("Error fetching Cost Explorer data:", error.message);
        throw new Error(`Failed to fetch Cost Explorer data: ${error.message}`);
      }

      const groups = response.ResultsByTime?.[0]?.Groups || [];

      if (groups.length === 0) {
        console.warn("No usage data found for the specified period");
      } else {
        console.log(`Found ${groups.length} usage groups`);
      }

      // Prepare CSV records with error handling
      const records = [["UsageType", "ReportedHours", "ClockHours"]];

      try {
        for (const group of groups) {
          const usageType = group.Keys?.[0];
          const metricsAmount = group.Metrics?.UsageQuantity?.Amount;

          if (!usageType || metricsAmount === undefined) {
            console.warn("Skipping incomplete group:", group);
            continue;
          }

          const reportedHours = parseFloat(metricsAmount);

          if (isNaN(reportedHours)) {
            console.warn(
              `Invalid reported hours for ${usageType}: ${metricsAmount}`
            );
            continue;
          }

          let clockHours = reportedHours;
          if (usageType.includes("BoxUsage:")) {
            const instanceType = usageType.split(":")[1];
            const vcpus = VCPUS[instanceType] || 1;
            clockHours = reportedHours / vcpus;

            if (!VCPUS[instanceType]) {
              console.warn(`Unknown instance type ${instanceType}, using 1 vCPU`);
            }
          } else {
            clockHours = reportedHours;
          }

          records.push([
            usageType,
            reportedHours.toFixed(2),
            clockHours.toFixed(2),
          ]);
        }
        console.log(`Processed ${records.length - 1} usage records`);
      } catch (error) {
        console.error("Error processing usage data:", error.message);
        throw new Error(`Failed to process usage data: ${error.message}`);
      }

      // Generate CSV with error handling
      let csvData;
      try {
        csvData = stringify(records);
        console.log("CSV data generated successfully");
      } catch (error) {
        console.error("Error generating CSV:", error.message);
        throw new Error(`Failed to generate CSV: ${error.message}`);
      }

      const fileName = `ec2_usage_${end.slice(0, 7)}.csv`;

      // Upload to S3 with error handling
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: fileName,
            Body: csvData,
            ContentType: "text/csv",
          })
        );
        console.log(`File uploaded to S3 successfully: ${fileName}`);
      } catch (error) {
        console.error("Error uploading to S3:", error.message);

        // Continue with email even if S3 upload fails
        console.log("Continuing with email despite S3 upload failure...");
      }

      // Create email content with attachment
      try {
        const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36)}`;
        const csvBase64 = Buffer.from(csvData).toString("base64");

        const rawMessage = [
          `From: ${SES_FROM}`,
          `To: ${SES_TO}`,
          `Subject: EC2 Usage Report for ${start.slice(0, 7)}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          ``,
          `--${boundary}`,
          `Content-Type: text/plain; charset=UTF-8`,
          ``,
          `Please find attached the EC2 usage report for ${start.slice(0, 7)}.`,
          ``,
          `Report Period: ${start} to ${end}`,
          `Total Usage Types: ${records.length - 1}`,
          ``,
          `--${boundary}`,
          `Content-Type: text/csv; name="${fileName}"`,
          `Content-Disposition: attachment; filename="${fileName}"`,
          `Content-Transfer-Encoding: base64`,
          ``,
          csvBase64,
          ``,
          `--${boundary}--`,
        ].join("\r\n");

        console.log("Sending email with attachment...");

        await ses.send(
          new SendEmailCommand({
            FromEmailAddress: SES_FROM,
            Destination: {
              ToAddresses: SES_TO,
            },
            Content: {
              Raw: {
                Data: Buffer.from(rawMessage),
              },
            },
          })
        );

        console.log("Email sent successfully");
      } catch (error) {
        console.error("Error sending email:", error.message);
        throw new Error(`Failed to send email: ${error.message}`);
      }

      console.log("EC2 usage report completed successfully");
      return {
        status: "success",
        file: fileName,
        recordCount: records.length - 1,
        reportPeriod: `${start} to ${end}`,
      };
    } catch (error) {
      console.error("Fatal error in handler:", error.message);
      console.error("Stack trace:", error.stack);

      // Optionally send error notification email
      try {
        await sendErrorNotification(error);
      } catch (notificationError) {
        console.error(
          "Failed to send error notification:",
          notificationError.message
        );
      }

      return {
        status: "error",
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  };

  // Function to send error notifications
  const sendErrorNotification = async (error) => {
    if (!SES_FROM || !SES_TO) {
      console.log("Skipping error notification - email addresses not configured");
      return;
    }

    try {
      const errorMessage = [
        `From: ${SES_FROM}`,
        `To: ${SES_TO}`,
        `Subject: EC2 Usage Report - Error Notification`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        `An error occurred while generating the EC2 usage report:`,
        ``,
        `Error: ${error.message}`,
        `Timestamp: ${new Date().toISOString()}`,
        ``,
        `Please check the logs for more details.`,
        ``,
        `Stack trace:`,
        `${error.stack}`,
      ].join("\r\n");

      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: SES_FROM,
          Destination: {
            ToAddresses: SES_TO,
          },
          Content: {
            Raw: {
              Data: Buffer.from(errorMessage),
            },
          },
        })
      );

      console.log("Error notification sent successfully");
    } catch (emailError) {
      console.error(
        "Failed to send error notification email:",
        emailError.message
      );
    }
  };

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    process.exit(1);
  });

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    process.exit(1);
  });

  handler().catch((error) => {
    console.error("Handler execution failed:", error);
    process.exit(1);
  });
