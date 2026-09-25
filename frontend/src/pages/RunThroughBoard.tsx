/**
 * /plays/:id/runthroughs 连排排期
 * 选排练日、开始时间与连排场次；操耍人从已派角色汇总，用时按场次时长合计。
 * 安排前逐人核对已排时段（含同一天已排的连排），撞期不记录并点明谁撞在哪一段；
 * 排期按排练日 + 开始时间列出，可取消，取消后时段重新空出。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Col,
  Empty,
  Form,
  Input,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  TimePicker,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  AlertOutlined,
  ArrowLeftOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  FieldTimeOutlined,
  ReadOutlined,
  ReloadOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { EmptyState } from '../components/common/EmptyState';
import { usePlayStore } from '../stores/playStore';
import { useOperatorStore, operatorNameOf } from '../stores/operatorStore';
import { useRunThroughStore } from '../stores/runThroughStore';
import { ROUTES } from '../router';
import {
  DAY_BASE_HOUR,
  WEEKDAY_LABEL,
  WEEKDAY_OPTIONS,
  minuteToClock,
  type Weekday,
} from '../types/operator';
import {
  collectParticipantIds,
  describeRunThroughConflict,
  sumRunThroughMinutes,
  type RunThroughConflict,
} from '../types/runThrough';
import { listRolesByScenes, listScenesByPlay, type RoleRow, type RunThroughRow, type SceneRow } from '../utils/db';
import { minutesToReadable } from '../utils/timecode';

interface RunThroughFormValues {
  weekday: Weekday;
  start: dayjs.Dayjs;
  sceneIds: string[];
  note?: string;
}

export default function RunThroughBoard() {
  const { id: playId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm<RunThroughFormValues>();

  const plays = usePlayStore((state) => state.plays);
  const selectPlay = usePlayStore((state) => state.selectPlay);
  const operators = useOperatorStore((state) => state.operators);

  const runThroughs = useRunThroughStore((state) => state.runThroughs);
  const loading = useRunThroughStore((state) => state.loading);
  const loadRunThroughs = useRunThroughStore((state) => state.loadRunThroughs);
  const scheduleRunThrough = useRunThroughStore((state) => state.scheduleRunThrough);
  const cancelRunThrough = useRunThroughStore((state) => state.cancelRunThrough);

  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [conflicts, setConflicts] = useState<RunThroughConflict[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const play = plays.find((item) => item.id === playId) ?? null;

  useEffect(() => {
    if (playId) selectPlay(playId);
  }, [playId, selectPlay]);

  const reloadLocal = useCallback(async () => {
    if (!playId) return;
    const sceneRows = await listScenesByPlay(playId);
    setScenes(sceneRows);
    setRoles(await listRolesByScenes(sceneRows.map((scene) => scene.id)));
  }, [playId]);

  useEffect(() => {
    setConflicts([]);
    void reloadLocal();
  }, [reloadLocal]);

  useEffect(() => {
    void loadRunThroughs();
  }, [loadRunThroughs]);

  // 场次载入后默认全选（连排通常整剧走一遍），用户可再勾选
  useEffect(() => {
    if (scenes.length > 0) {
      form.setFieldsValue({ sceneIds: scenes.map((scene) => scene.id) });
    }
  }, [scenes, form]);

  const watchedSceneIds = Form.useWatch('sceneIds', form) ?? [];
  const watchedWeekday = Form.useWatch('weekday', form);
  const watchedStart = Form.useWatch('start', form);

  /** 合计用时：按勾选场次时长加起来 */
  const totalMinute = useMemo(
    () => sumRunThroughMinutes(scenes, watchedSceneIds),
    [scenes, watchedSceneIds],
  );

  /** 参与操耍人：从已派角色汇总，附带每人担纲的角色名 */
  const participants = useMemo(() => {
    const ids = collectParticipantIds(roles, watchedSceneIds);
    return ids.map((operatorId) => {
      const roleNames = [
        ...new Set(
          roles
            .filter((role) => role.operatorId === operatorId && watchedSceneIds.includes(role.sceneId))
            .map((role) => role.name),
        ),
      ];
      return { operatorId, name: operatorNameOf(operators, operatorId), roleNames };
    });
  }, [roles, watchedSceneIds, operators]);

  const unassignedCount = useMemo(
    () => roles.filter((role) => watchedSceneIds.includes(role.sceneId) && role.operatorId === null).length,
    [roles, watchedSceneIds],
  );

  const previewStartMinute = watchedStart
    ? watchedStart.hour() * 60 + watchedStart.minute() - DAY_BASE_HOUR * 60
    : null;

  const playTitleOf = useCallback(
    (id: string) => plays.find((item) => item.id === id)?.title ?? '未命名剧目',
    [plays],
  );

  const playRunThroughs = useMemo(
    () => runThroughs.filter((item) => item.playId === playId),
    [runThroughs, playId],
  );
  const totalScheduledMinute = useMemo(
    () => runThroughs.reduce((acc, item) => acc + item.durationMinute, 0),
    [runThroughs],
  );
  const crewCount = useMemo(
    () => new Set(runThroughs.flatMap((item) => item.operatorIds)).size,
    [runThroughs],
  );

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (!values.sceneIds || values.sceneIds.length === 0) {
      message.warning('请至少勾选一场连排场次');
      return;
    }
    const startMinute = values.start.hour() * 60 + values.start.minute() - DAY_BASE_HOUR * 60;
    if (startMinute < 0) {
      message.warning('连排开始时间请安排在 08:00 之后');
      return;
    }
    setSubmitting(true);
    try {
      const result = await scheduleRunThrough({
        playId,
        weekday: values.weekday,
        startMinute,
        sceneIds: values.sceneIds,
        note: values.note ?? '',
      });
      if (result.ok) {
        setConflicts([]);
        message.success(
          `已记下 ${WEEKDAY_LABEL[result.row.weekday]} ${minuteToClock(result.row.startMinute)} 的连排，用时 ${minutesToReadable(result.row.durationMinute)}`,
        );
      } else if (result.conflicts.length > 0) {
        setConflicts(result.conflicts);
        message.warning('有人撞期，这场连排没有记下来');
      } else {
        message.warning('连排场次为空或时长为零，未安排');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (record: RunThroughRow) => {
    await cancelRunThrough(record.id);
    setConflicts([]);
    message.success(
      `已取消 ${WEEKDAY_LABEL[record.weekday]} ${minuteToClock(record.startMinute)} 的连排，这段时段重新空出来了`,
    );
  };

  const scheduleColumns: ColumnsType<RunThroughRow> = [
    {
      title: '排练日',
      dataIndex: 'weekday',
      width: 76,
      render: (value: Weekday) => <Tag color="gold">{WEEKDAY_LABEL[value]}</Tag>,
    },
    {
      title: '时段',
      key: 'range',
      width: 118,
      render: (_value, record) => (
        <span className="gb-mono">
          {minuteToClock(record.startMinute)} - {minuteToClock(record.startMinute + record.durationMinute)}
        </span>
      ),
    },
    {
      title: '剧目',
      dataIndex: 'playId',
      width: 150,
      ellipsis: true,
      render: (value: string) => (
        <Space size={4}>
          <span>{playTitleOf(value)}</span>
          {value === playId ? <Tag color="#7a1f1f">本剧</Tag> : null}
        </Space>
      ),
    },
    {
      title: '连排场次',
      dataIndex: 'sceneTitles',
      ellipsis: true,
      render: (value: string[], record) => (
        <span title={value.join('、')}>
          {record.sceneIds.length} 场：{value.join('、')}
        </span>
      ),
    },
    {
      title: '操耍人',
      dataIndex: 'operatorIds',
      width: 150,
      ellipsis: true,
      render: (value: string[]) =>
        value.length > 0 ? value.map((id) => operatorNameOf(operators, id)).join('、') : '（无已派操耍人）',
    },
    {
      title: '用时',
      dataIndex: 'durationMinute',
      width: 96,
      render: (value: number) => minutesToReadable(value),
    },
    {
      title: '操作',
      key: 'action',
      width: 72,
      render: (_value, record) => (
        <Popconfirm
          title="取消这场连排？"
          description="取消后这段时段会重新空出来。"
          okText="取消连排"
          okButtonProps={{ danger: true }}
          cancelText="再想想"
          onConfirm={() => void handleCancel(record)}
        >
          <Button size="small" danger icon={<DeleteOutlined />}>
            取消
          </Button>
        </Popconfirm>
      ),
    },
  ];

  if (!play) {
    return (
      <div className="gb-panel">
        <EmptyState
          title="未找到该剧目"
          description="剧目可能已被删除，请回到剧目库重新选择。"
          actionText="回到剧目库"
          onAction={() => navigate(ROUTES.plays)}
        />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plays)}>
              剧目库
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              连排排期 · {play.title}
            </Typography.Title>
            <Tag color="gold">本周全社已排 {runThroughs.length} 场</Tag>
          </Space>
          <Space wrap>
            <Button icon={<ReadOutlined />} onClick={() => navigate(ROUTES.scenes(playId))}>
              场次拆分
            </Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadRunThroughs()}>
              刷新排期
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="全社本周连排" value={runThroughs.length} prefix={<CalendarOutlined />} suffix="场" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="全社连排合计" value={minutesToReadable(totalScheduledMinute)} prefix={<FieldTimeOutlined />} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="本剧已排连排" value={playRunThroughs.length} suffix="场" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="连排涉及操耍人" value={crewCount} prefix={<TeamOutlined />} suffix="人" />
          </Col>
        </Row>
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={10}>
          <div className="gb-panel">
            <div className="gb-panel-title">
              <Typography.Text strong>安排一场连排</Typography.Text>
              <Tag icon={<ClockCircleOutlined />}>08:00 起算</Tag>
            </div>

            {scenes.length === 0 ? (
              <EmptyState
                size="small"
                title="还没有场次可排"
                description="连排按场次凑段，请先到场次拆分页把这出戏拆出场次。"
                actionText="去拆场次"
                onAction={() => navigate(ROUTES.scenes(playId))}
              />
            ) : (
              <Form
                form={form}
                layout="vertical"
                initialValues={{
                  weekday: 1 as Weekday,
                  start: dayjs().hour(DAY_BASE_HOUR).minute(0).second(0),
                  sceneIds: [] as string[],
                  note: '',
                }}
                onValuesChange={() => setConflicts([])}
              >
                <Row gutter={12}>
                  <Col span={12}>
                    <Form.Item name="weekday" label="排练日" rules={[{ required: true, message: '请选择排练日' }]}>
                      <Select options={[...WEEKDAY_OPTIONS]} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="start" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
                      <TimePicker format="HH:mm" minuteStep={15} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>

                <Form.Item
                  name="sceneIds"
                  label="连排场次（用时按场次时长合计）"
                  rules={[{ required: true, message: '请勾选连排场次' }]}
                >
                  <Checkbox.Group
                    options={scenes.map((scene) => ({
                      value: scene.id,
                      label: `${scene.title}（${scene.durationMin} 分钟）`,
                    }))}
                  />
                </Form.Item>

                <Form.Item name="note" label="备注" rules={[{ max: 40, message: '不超过 40 个字' }]}>
                  <Input placeholder="如：全剧连排，重点合第三场水漫" />
                </Form.Item>

                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={
                    previewStartMinute !== null && previewStartMinute >= 0 && watchedSceneIds.length > 0
                      ? `${WEEKDAY_LABEL[watchedWeekday as Weekday] ?? ''} ${minuteToClock(previewStartMinute)} 开排，合计 ${minutesToReadable(totalMinute)}，预计 ${minuteToClock(previewStartMinute + totalMinute)} 收工`
                      : '选好排练日、开始时间与场次后，这里会算出合计用时'
                  }
                  description={
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Typography.Text style={{ fontSize: 12 }}>
                        参与操耍人（从已派角色汇总，共 {participants.length} 人）：
                      </Typography.Text>
                      {participants.length === 0 ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          所选场次还没有已派操耍人，可先到角色指派页派角。
                        </Typography.Text>
                      ) : (
                        <Space size={4} wrap>
                          {participants.map((item) => (
                            <Tag key={item.operatorId} color="#7a1f1f">
                              {item.name}
                              {item.roleNames.length > 0 ? `（${item.roleNames.join('／')}）` : ''}
                            </Tag>
                          ))}
                        </Space>
                      )}
                      {unassignedCount > 0 ? (
                        <Typography.Text type="warning" style={{ fontSize: 12 }}>
                          所选场次还有 {unassignedCount} 个角色未派操耍人，不计入撞期核对。
                        </Typography.Text>
                      ) : null}
                    </Space>
                  }
                />

                {conflicts.length > 0 ? (
                  <Alert
                    type="error"
                    showIcon
                    closable
                    onClose={() => setConflicts([])}
                    style={{ marginBottom: 12 }}
                    message={`这场连排没记下：${conflicts.length} 处撞期`}
                    description={
                      <Space direction="vertical" size={2}>
                        {conflicts.map((conflict, index) => (
                          <Typography.Text key={index} type="danger" style={{ fontSize: 12 }}>
                            <AlertOutlined /> {describeRunThroughConflict(conflict)}
                          </Typography.Text>
                        ))}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          换个排练日或开始时间再试；同名时段取消后也会重新空出。
                        </Typography.Text>
                      </Space>
                    }
                  />
                ) : null}

                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  loading={submitting}
                  disabled={watchedSceneIds.length === 0}
                  onClick={() => void handleSubmit()}
                  block
                >
                  核对时段并记下这场连排
                </Button>
              </Form>
            )}
          </div>
        </Col>

        <Col xs={24} xl={14}>
          <div className="gb-panel">
            <div className="gb-panel-title">
              <Typography.Text strong>全社连排排期（按排练日 + 开始时间）</Typography.Text>
              <Tag>{runThroughs.length} 场</Tag>
            </div>
            <Table<RunThroughRow>
              rowKey="id"
              size="small"
              className="gb-table-compact"
              tableLayout="fixed"
              loading={loading}
              columns={scheduleColumns}
              dataSource={runThroughs}
              pagination={false}
              rowClassName={(record) => (record.playId === playId ? 'gb-row-current' : '')}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="本周还没有排连排，左侧选好时段即可安排"
                  />
                ),
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              同一天已排的连排也算占用：新安排若与表中任何一场重叠，会被拦下并点明撞在哪一段。
            </Typography.Text>
          </div>
        </Col>
      </Row>
    </Space>
  );
}
