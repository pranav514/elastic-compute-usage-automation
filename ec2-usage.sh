


YEAR=2025

declare -A VCPUS=(
  [t2.micro]=1
  [t2.small]=1
  [t2.medium]=2
  [t2.large]=2
  [c5.large]=2
  [c5.xlarge]=4
  [c5.2xlarge]=8
  [c5.4xlarge]=16
  [c5.9xlarge]=36
  [c5.18xlarge]=72
  [g4dn.xlarge]=4
  [g4dn.2xlarge]=8
  [g4dn.4xlarge]=16
  [g5.xlarge]=4
  [g5.2xlarge]=8
  [g5.4xlarge]=16
)


for MONTH in {06..08}
do

  END_DATE=$(date -d "$YEAR-$MONTH-01 +1 month -1 day" +%Y-%m-%d)


  FILE="ec2_usage_${YEAR}-${MONTH}.csv"

  echo "UsageType,ReportedHours,ClockHours" > $FILE

  DATA=$(aws ce get-cost-and-usage \
    --time-period Start=${YEAR}-${MONTH}-01,End=$END_DATE \
    --granularity MONTHLY \
    --metrics "UsageQuantity" \
    --filter '{"And":[{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Compute Cloud - Compute"]}},{"Dimensions":{"Key":"REGION","Values":["ap-south-1"]}}]}' \
    --group-by Type=DIMENSION,Key=USAGE_TYPE \
    --query 'ResultsByTime[0].Groups[*].[Keys[0], Metrics.UsageQuantity.Amount]' \
    --output text)


  while IFS=$'\t' read -r USAGE HOURS; do
    if [[ $USAGE == *BoxUsage* ]]; then
      INST_TYPE=$(echo "$USAGE" | cut -d: -f2)
      VCPU=${VCPUS[$INST_TYPE]:-1}  
      CLOCK_HOURS=$(echo "$HOURS / $VCPU" | bc -l)
      echo "$USAGE,$HOURS,$CLOCK_HOURS" >> $FILE
    else
      echo "$USAGE,$HOURS,$HOURS" >> $FILE
    fi
  done <<< "$DATA"

  echo "Saved $FILE"
done

