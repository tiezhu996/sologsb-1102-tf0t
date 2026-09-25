/**
 * /plays/:id/rehearsals 连排排期
 * 选排练日、开始时间与连排场次；参与操耍人从已派角色汇总，用时按场次时长合计。
 * 安排前把参与人的已排时段（含同一天已排的连排）对一遍，
 * 撞期则整场不记下来并点明谁撞在哪一段；已排连排可取消，取消后时段重新空出。
 */
import { useEffect, useMemo, useState } from 'react';
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
  CheckSquareOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { EmptyState } from '../components/common/EmptyState';
import { usePlayStore } from '../stores/playStore';
import { useSceneStore } from '../stores/sceneStore';
import { useOperatorStore, operatorNameOf } from '../stores/operatorStore';
import { useRehearsalStore } from '../stores/rehearsalStore';
import { ROUTES } from '../router';
import {
  DAY_BASE_HOUR,
  WEEKDAY_LABEL,
  WEEKDAY_OPTIONS,
  minuteToClock,
  type Weekday,
} from '../types/operator';
import {
  describeRehearsalConflict,
  rehearsalDurationMin,
  rehearsalParticipantIds,
  type RehearsalConflict,
} from '../types/rehearsal';
import { listRolesByScenes, type RehearsalRow, type RoleRow } from '../utils/db';
import { minutesToReadable } from '../utils/timecode';

interface RehearsalFormValues {
  weekday: Weekday;
  start: dayjs.Dayjs;
  sceneIds: string[];
  note?: string;
}

export default function RehearsalPlan() {
  const { id: playId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<RehearsalFormValues>();

  const plays = usePlayStore((state) => state.plays);
  const selectPlay = usePlayStore((state) => state.selectPlay);
  const refreshCounts = usePlayStore((state) => state.refreshCounts);

  const scenes = useSceneStore((state) => state.scenes);
  const loadScenes = useSceneStore((state) => state.loadScenes);

  const operators = useOperatorStore((state) => state.operators);

  const rehearsals = useRehearsalStore((state) => state.rehearsals);
  const loading = useRehearsalStore((state) => state.loading);
  const error = useRehearsalStore((state) => state.error);
  const loadRehearsals = useRehearsalStore((state) => state.loadRehearsals);
  const schedule = useRehearsalStore((state) => state.schedule);
  const cancel = useRehearsalStore((state) => state.cancel);
  const rehearsalsOfPlay = useRehearsalStore((state) => state.rehearsalsOfPlay);

  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [conflicts, setConflicts] = useState<RehearsalConflict[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const play = plays.find((item) => item.id === playId) ?? null;
  const orderedScenes = useMemo(() => [...scenes].sort((a, b) => a.seq - b.seq), [scenes]);

  useEffect(() => {
    if (playId) {
      selectPlay(playId);
      void loadScenes(playId);
    }
  }, [playId, selectPlay, loadScenes]);

  useEffect(() => {
    void loadRehearsals();
  }, [loadRehearsals]);

  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);

  // 场次变化时重拉角色，保证「参与操耍人」按最新指派汇总
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await listRolesByScenes(orderedScenes.map((scene) => scene.id));
      if (!cancelled) setRoles(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [orderedScenes]);

  const watchedSceneIds = Form.useWatch('sceneIds', form) ?? [];
  const watchedDuration = rehearsalDurationMin(watchedSceneIds, orderedScenes);
  const watchedParticipants = rehearsalParticipantIds(watchedSceneIds, roles);

  const playRehearsals = useMemo(
    () => rehearsalsOfPlay(playId),
    // rehearsals 变化时 rehearsalsOfPlay 的结果才变
    [rehearsalsOfPlay, rehearsals, playId],
  );

  const weeklyMinute = playRehearsals.reduce((acc, row) => acc + rehearsalDurationMin(row.sceneIds, orderedScenes), 0);
  const weeklyParticipants = new Set(playRehearsals.flatMap((row) => rehearsalParticipantIds(row.sceneIds, roles)));

  const handleSchedule = async () => {
    const values = await form.validateFields();
    const startMinute = values.start.hour() * 60 + values.start.minute() - DAY_BASE_HOUR * 60;
    if (startMinute < 0) {
      message.warning('连排请安排在 08:00 之后');
      return;
    }
    setSubmitting(true);
    const result = await schedule({
      playId,
      weekday: values.weekday,
      startMinute,
      sceneIds: values.sceneIds,
      note: values.note ?? '',
    });
    setSubmitting(false);
    if (!result.ok) {
      setConflicts(result.conflicts);
      message.error('有操耍人撞期，这场连排不记下来');
      return;
    }
    setConflicts([]);
    form.resetFields();
    await refreshCounts();
    message.success(`已记下${WEEKDAY_LABEL[values.weekday]} ${minuteToClock(startMinute)} 起的连排`);
  };

  const handleCancel = (row: RehearsalRow) => {
    const duration = rehearsalDurationMin(row.sceneIds, orderedScenes);
    modal.confirm({
      title: `取消${WEEKDAY_LABEL[row.weekday]} ${minuteToClock(row.startMinute)} 的连排？`,
      content: `这场连排共 ${minutesToReadable(duration)}，取消后这段时段重新空出来，可再安排别的连排。`,
      okText: '取消连排',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        await cancel(row.id);
        await refreshCounts();
        message.success('连排已取消，时段重新空出来了');
      },
    });
  };

  const columns: ColumnsType<RehearsalRow> = [
    {
      title: '排练日',
      dataIndex: 'weekday',
      width: 76,
      render: (value: Weekday) => <Tag color="#7a1f1f">{WEEKDAY_LABEL[value]}</Tag>,
    },
    {
      title: '时段',
      key: 'range',
      width: 128,
      render: (_value, record) => (
        <span className="gb-mono">
          {minuteToClock(record.startMinute)} -{' '}
          {minuteToClock(record.startMinute + rehearsalDurationMin(record.sceneIds, orderedScenes))}
        </span>
      ),
    },
    {
      title: '连排场次',
      dataIndex: 'sceneIds',
      ellipsis: true,
      render: (value: string[]) => {
        const titles = value.map(
          (sceneId) => orderedScenes.find((scene) => scene.id === sceneId)?.title ?? '（场次已删）',
        );
        return titles.join('、');
      },
    },
    {
      title: '参与操耍人',
      key: 'participants',
      width: 200,
      render: (_value, record) => {
        const ids = rehearsalParticipantIds(record.sceneIds, roles);
        if (ids.length === 0) return <Typography.Text type="secondary">暂无已派操耍人</Typography.Text>;
        return (
          <Space size={4} wrap>
            {ids.map((id) => (
              <Tag key={id}>{operatorNameOf(operators, id)}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '用时',
      key: 'duration',
      width: 96,
      render: (_value, record) => minutesToReadable(rehearsalDurationMin(record.sceneIds, orderedScenes)),
    },
    {
      title: '备注',
      dataIndex: 'note',
      width: 140,
      ellipsis: true,
      render: (value: string) => value || '—',
    },
    {
      title: '操作',
      key: 'action',
      width: 88,
      render: (_value, record) => (
        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleCancel(record)}>
          取消
        </Button>
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
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.scenes(playId))}>
              场次拆分
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              连排排期 · {play.title}
            </Typography.Title>
            <Tag color="gold">本周已排 {playRehearsals.length} 次</Tag>
          </Space>
          <Button icon={<TeamOutlined />} onClick={() => navigate(ROUTES.operators)}>
            翻操耍人档
          </Button>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="本周连排次数" value={playRehearsals.length} prefix={<CalendarOutlined />} suffix="次" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="本周连排合计" value={minutesToReadable(weeklyMinute)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="涉及操耍人" value={weeklyParticipants.size} prefix={<TeamOutlined />} suffix="人" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="整剧场次" value={orderedScenes.length} suffix="场" />
          </Col>
        </Row>

        <Alert
          style={{ marginTop: 14 }}
          type="info"
          showIcon
          message="班社一周排两三次连排：选好排练日、开始时间与场次，安排前会自动把参与操耍人的已排时段对一遍，撞期的连排不记下来。"
        />
      </div>

      {orderedScenes.length === 0 ? (
        <div className="gb-panel">
          <EmptyState
            title="这出戏还没有场次"
            description="连排按场次组织，先到场次拆分页把这出戏拆出场次，再回来排连排。"
            actionText="去拆场次"
            onAction={() => navigate(ROUTES.scenes(playId))}
          />
        </div>
      ) : (
        <Row gutter={16}>
          <Col xs={24} xl={10}>
            <div className="gb-panel">
              <div className="gb-panel-title">
                <Typography.Text strong>安排一场连排</Typography.Text>
                <Tag icon={<ClockCircleOutlined />} color="default">
                  08:00 起算
                </Tag>
              </div>

              <Form
                form={form}
                layout="vertical"
                initialValues={{
                  weekday: 1 as Weekday,
                  start: dayjs().hour(DAY_BASE_HOUR).minute(0),
                  sceneIds: [] as string[],
                  note: '',
                }}
                onValuesChange={() => {
                  if (conflicts.length > 0) setConflicts([]);
                }}
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
                  rules={[{ required: true, message: '至少勾选一场' }]}
                >
                  <Checkbox.Group
                    style={{ width: '100%' }}
                    options={orderedScenes.map((scene) => ({
                      value: scene.id,
                      label: `第${scene.seq}场·${scene.title}（${scene.durationMin} 分钟）`,
                    }))}
                  />
                </Form.Item>
                <Space size={8} style={{ marginTop: -12, marginBottom: 12 }}>
                  <Button
                    size="small"
                    icon={<CheckSquareOutlined />}
                    onClick={() => form.setFieldsValue({ sceneIds: orderedScenes.map((scene) => scene.id) })}
                  >
                    全选整场
                  </Button>
                  <Button size="small" onClick={() => form.setFieldsValue({ sceneIds: [] })}>
                    清空
                  </Button>
                </Space>

                <Form.Item name="note" label="备注" rules={[{ max: 40, message: '不超过 40 个字' }]}>
                  <Input placeholder="如：合乐前最后一次连排" />
                </Form.Item>

                <Alert
                  type={watchedParticipants.length > 0 ? 'success' : 'warning'}
                  showIcon
                  message={
                    watchedSceneIds.length === 0
                      ? '先勾选连排场次，这里会汇总用时与参与操耍人'
                      : `合计 ${minutesToReadable(watchedDuration)}，参与操耍人 ${watchedParticipants.length} 人`
                  }
                  description={
                    watchedSceneIds.length === 0 ? null : watchedParticipants.length > 0 ? (
                      <Space size={4} wrap>
                        {watchedParticipants.map((id) => (
                          <Tag key={id}>{operatorNameOf(operators, id)}</Tag>
                        ))}
                      </Space>
                    ) : (
                      '所选场次还没有已派操耍人的角色，可先到角色指派页派工；现在记下也行，之后不参与撞期核对。'
                    )
                  }
                />

                {conflicts.length > 0 ? (
                  <Alert
                    style={{ marginTop: 12 }}
                    type="error"
                    showIcon
                    icon={<AlertOutlined />}
                    message={`${conflicts.length} 处撞期，这场连排未记下`}
                    description={
                      <Space direction="vertical" size={2}>
                        {conflicts.map((conflict) => (
                          <Typography.Text
                            key={`${conflict.operatorId}-${conflict.overlapStart}-${conflict.sourceLabel}`}
                            type="danger"
                            style={{ fontSize: 12 }}
                          >
                            {describeRehearsalConflict(conflict)}
                          </Typography.Text>
                        ))}
                      </Space>
                    }
                  />
                ) : null}

                <Button
                  style={{ marginTop: 14 }}
                  type="primary"
                  icon={<CalendarOutlined />}
                  loading={submitting}
                  onClick={() => void handleSchedule()}
                >
                  对时段并记下连排
                </Button>
              </Form>
            </div>
          </Col>

          <Col xs={24} xl={14}>
            <div className="gb-panel">
              <div className="gb-panel-title">
                <Typography.Text strong>已排连排（按排练日与开始时间）</Typography.Text>
                <Tag color={playRehearsals.length > 0 ? '#7a1f1f' : 'default'}>{playRehearsals.length} 场</Tag>
              </div>
              <Table<RehearsalRow>
                rowKey="id"
                size="small"
                className="gb-table-compact"
                tableLayout="fixed"
                loading={loading}
                columns={columns}
                dataSource={playRehearsals}
                pagination={false}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="本周还没有排连排，左侧选好排练日与场次即可安排"
                    />
                  ),
                }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
                取消连排后，这段时段立即空出来；同一天已排的连排也会参与后续安排的撞期核对。
              </Typography.Text>
            </div>
          </Col>
        </Row>
      )}
    </Space>
  );
}
