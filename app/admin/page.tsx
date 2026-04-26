'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import imageCompression from 'browser-image-compression';

import ProtectedRoute from '@/components/auth/ProtectedRoute';
import LogoutButton from '@/components/auth/LogoutButton';
import DashboardView from '@/components/admin/DashboardView';
import CreateUserForm from '@/components/admin/CreateUserForm';
import UserManagementView from '../../components/admin/UserManagementView';
import ReachOutView from '@/components/admin/ReachOutView';
import RoleSidebarLayout, { type NavigationItem } from '@/components/navigation/RoleSidebarLayout';

import { auth } from '@/lib/firebase/client';
import { belongsToCoadmin } from '@/lib/coadmin/scope';

import {
  CoadminUser,
  DeletedPlayerRecord,
  deletePlayerForever,
  deletePlayer,
  StaffUser,
  PlayerUser,
  blockCoadmin,
  blockStaff,
  createCoadmin,
  createStaff,
  deleteCoadmin,
  deleteStaff,
  getCoadmins,
  getDeletedPlayers,
  getPlayers,
  getStaff,
  recreateDeletedPlayer,
  unblockCoadmin,
  unblockStaff,
} from '@/features/users/adminUsers';

import {
  listenToUnreadCounts,
  markConversationAsRead,
  sendChatMessage,
  sendImageMessage,
} from '@/features/messages/chatMessages';
import { usePaginatedChatMessages } from '@/features/messages/usePaginatedChatMessages';
import { usePresenceOnlineMap } from '@/features/presence/userPresence';
import { OnlineIndicator } from '@/components/presence/OnlineIndicator';

import { AdminUser, AdminView, ChatMessage } from '@/components/admin/types';

const AED_TO_USD = 0.2723;
const NPR_TO_USD = 0.0075;

export default function AdminPage() {
  const [activeView, setActiveView] = useState<AdminView>('dashboard');

  const [coadminUsername, setCoadminUsername] = useState('');
  const [coadminPassword, setCoadminPassword] = useState('');
  const [coadmins, setCoadmins] = useState<CoadminUser[]>([]);
  const [selectedCoadmin, setSelectedCoadmin] = useState<CoadminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CoadminUser | null>(null);

  const [staffUsername, setStaffUsername] = useState('');
  const [staffPassword, setStaffPassword] = useState('');
  const [staffList, setStaffList] = useState<StaffUser[]>([]);
  const [players, setPlayers] = useState<PlayerUser[]>([]);
  const [deletedPlayers, setDeletedPlayers] = useState<DeletedPlayerRecord[]>([]);
  const [allStaffForCoadmins, setAllStaffForCoadmins] = useState<StaffUser[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<StaffUser | null>(null);
  const [deleteStaffTarget, setDeleteStaffTarget] = useState<StaffUser | null>(null);

  const [chatUsers, setChatUsers] = useState<AdminUser[]>([]);
  const [selectedChatUser, setSelectedChatUser] = useState<AdminUser | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const reachOutScrollRef = useRef<HTMLDivElement>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);

  const previousTotalUnreadRef = useRef(0);

  const pagedReachOut = usePaginatedChatMessages(selectedChatUser?.uid ?? null, {
    scrollContainerRef: reachOutScrollRef,
    onWindowMessages: () => {
      if (selectedChatUser) {
        markConversationAsRead(selectedChatUser.uid);
      }
    },
  });

  const messages: ChatMessage[] = useMemo(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      return [];
    }
    return pagedReachOut.items.map((msg) => ({
      id: msg.id,
      text: msg.text,
      imageUrl: msg.imageUrl,
      sender: msg.senderUid === currentUser.uid ? 'admin' : 'user',
      timestamp: msg.createdAt?.toDate?.() || new Date(),
    }));
  }, [pagedReachOut.items]);

  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [monthlyNetUsdInput, setMonthlyNetUsdInput] = useState('30000');
  const [ownerSharePercentInput, setOwnerSharePercentInput] = useState('40');
  const [staffPayoutAedInput, setStaffPayoutAedInput] = useState('12000');
  const [carerPayoutNprInput, setCarerPayoutNprInput] = useState('800000');

  const totalUnreadCount = Object.values(unreadCounts).reduce(
    (total, count) => total + count,
    0
  );

  const profitModel = useMemo(() => {
    const monthlyNetUsd = Number(monthlyNetUsdInput || 0);
    const ownerSharePercent = Number(ownerSharePercentInput || 0);
    const totalStaffPayoutAed = Number(staffPayoutAedInput || 0);
    const totalCarerPayoutNpr = Number(carerPayoutNprInput || 0);

    const ownerShareUsd = (monthlyNetUsd * ownerSharePercent) / 100;
    const staffUsd = totalStaffPayoutAed * AED_TO_USD;
    const carerUsd = totalCarerPayoutNpr * NPR_TO_USD;
    const ownerFinalProfitUsd = ownerShareUsd - staffUsd - carerUsd;
    const payoutUsd = staffUsd + carerUsd;

    return {
      monthlyNetUsd,
      ownerSharePercent,
      totalStaffPayoutAed,
      totalCarerPayoutNpr,
      ownerShareUsd,
      staffUsd,
      carerUsd,
      payoutUsd,
      ownerFinalProfitUsd,
      isNegativeProfit: ownerFinalProfitUsd < 0,
      payoutExceedsOwnerShare: payoutUsd > ownerShareUsd,
      payoutOverHalfShare: payoutUsd > ownerShareUsd * 0.5,
    };
  }, [
    monthlyNetUsdInput,
    ownerSharePercentInput,
    staffPayoutAedInput,
    carerPayoutNprInput,
  ]);

  useEffect(() => {
    if (activeView === 'dashboard') {
      loadCoadmins();
      loadStaffList();
      loadChatUsers();
    }

    if (activeView === 'view-coadmins') {
      loadCoadmins();
      loadAllStaffForCoadmins();
    }

    if (activeView === 'view-staff') {
      loadStaffList();
    }

    if (activeView === 'players') {
      loadPlayers();
      loadDeletedPlayers();
    }

    if (activeView === 'reach-out') {
      loadChatUsers();
    }
  }, [activeView]);

  useEffect(() => {
    const currentUser = auth.currentUser;

    if (!currentUser) {
      return;
    }

    const unsubscribe = listenToUnreadCounts(setUnreadCounts);

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (totalUnreadCount > previousTotalUnreadRef.current) {
      playNotificationSound();
    }

    previousTotalUnreadRef.current = totalUnreadCount;
  }, [totalUnreadCount]);

  function playNotificationSound() {
    const audio = new Audio('/notification.mp3');
    audio.volume = 0.6;

    audio.play().catch(() => {
      // Browser may block sound until user interacts with the page.
    });
  }

  async function loadCoadmins() {
    setLoadingList(true);

    try {
      const list = await getCoadmins();
      setCoadmins(list);
    } catch (err: any) {
      setMessage(err.message || 'Failed to load co-admins.');
    } finally {
      setLoadingList(false);
    }
  }

 async function loadStaffList() {
  setLoadingList(true);

  try {
    const currentUser = auth.currentUser;

    if (!currentUser) {
      throw new Error('Not authenticated.');
    }

    const list = await getStaff();

    const adminStaff = list.filter(
      (staff) => staff.createdBy === currentUser.uid
    );

    setStaffList(adminStaff);
  } catch (err: any) {
    setMessage(err.message || 'Failed to load staff.');
  } finally {
    setLoadingList(false);
  }
}

  async function loadPlayers() {
    setLoadingList(true);

    try {
      const list = await getPlayers();
      setPlayers(list);
    } catch (err: any) {
      setMessage(err.message || 'Failed to load players.');
    } finally {
      setLoadingList(false);
    }
  }

  async function loadDeletedPlayers() {
    try {
      const list = await getDeletedPlayers();
      setDeletedPlayers(list);
    } catch (err: any) {
      setMessage(err.message || 'Failed to load deleted players.');
    }
  }

  async function loadAllStaffForCoadmins() {
    try {
      const list = await getStaff();
      setAllStaffForCoadmins(list);
    } catch (err: any) {
      setMessage(err.message || 'Failed to load co-admin staff list.');
    }
  }

  async function loadChatUsers() {
  try {
    const coadminsList = await getCoadmins();

    // ONLY coadmins, no staff
    setChatUsers(coadminsList);
  } catch (err: any) {
    setMessage(err.message || 'Failed to load users.');
  }
}

  async function handleCreateCoadmin(e: React.FormEvent) {
    e.preventDefault();

    setLoading(true);
    setMessage('');

    try {
      await createCoadmin(coadminUsername, coadminPassword);

      setCoadminUsername('');
      setCoadminPassword('');
      setMessage('Co-admin created successfully.');

      await loadCoadmins();
      await loadChatUsers();
    } catch (err: any) {
      setMessage(err.message || 'Failed to create co-admin.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateStaff(e: React.FormEvent) {
    e.preventDefault();

    setLoading(true);
    setMessage('');

    try {
      await createStaff(staffUsername, staffPassword);

      setStaffUsername('');
      setStaffPassword('');
      setMessage('Staff created successfully.');

      await loadStaffList();
      await loadChatUsers();
    } catch (err: any) {
      setMessage(err.message || 'Failed to create staff.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteCoadmin() {
    if (!deleteTarget) return;

    setLoading(true);

    try {
      await deleteCoadmin(deleteTarget);
      await loadCoadmins();
      await loadChatUsers();

      if (selectedChatUser?.uid === deleteTarget.uid) {
        setSelectedChatUser(null);
      }

      setSelectedCoadmin(null);
      setDeleteTarget(null);
      setMessage('Co-admin deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteStaff() {
    if (!deleteStaffTarget) return;

    setLoading(true);

    try {
      await deleteStaff(deleteStaffTarget);
      await loadStaffList();
      await loadChatUsers();

      if (selectedChatUser?.uid === deleteStaffTarget.uid) {
        setSelectedChatUser(null);
      }

      setSelectedStaff(null);
      setDeleteStaffTarget(null);
      setMessage('Staff deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteSpecificStaff(staff: StaffUser) {
    setLoading(true);

    try {
      await deleteStaff(staff);
      await Promise.all([loadStaffList(), loadAllStaffForCoadmins(), loadChatUsers()]);

      if (selectedChatUser?.uid === staff.uid) {
        setSelectedChatUser(null);
      }

      setMessage('Staff deleted.');
    } catch (err: any) {
      setMessage(err.message || 'Delete failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeletePlayer(player: PlayerUser) {
    setLoading(true);
    setMessage('');

    try {
      await deletePlayer(player);
      await Promise.all([loadPlayers(), loadDeletedPlayers()]);
      setMessage('Player archived successfully.');
    } catch (err: any) {
      setMessage(err.message || 'Failed to archive player.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRecreatePlayer(player: DeletedPlayerRecord) {
    setLoading(true);
    setMessage('');

    try {
      const response = await recreateDeletedPlayer(player.uid);
      await Promise.all([loadPlayers(), loadDeletedPlayers()]);
      const passwordPart = response.temporaryPassword
        ? ` Temporary password: ${response.temporaryPassword}`
        : '';
      setMessage(`Player recreated successfully.${passwordPart}`);
    } catch (err: any) {
      setMessage(err.message || 'Failed to recreate player.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeletePlayerForever(player: DeletedPlayerRecord) {
    setLoading(true);
    setMessage('');

    try {
      await deletePlayerForever(player.uid);
      await loadDeletedPlayers();
      setMessage('Deleted player archive removed permanently.');
    } catch (err: any) {
      setMessage(err.message || 'Failed to remove deleted player archive.');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleCoadminStatus(user: CoadminUser) {
    setBlocking(true);
    setMessage('');

    try {
      if (user.status === 'disabled') {
        await unblockCoadmin(user);
      } else {
        await blockCoadmin(user);
      }

      await loadCoadmins();
      setMessage(
        `Co-admin ${user.status === 'disabled' ? 'unblocked' : 'blocked'} successfully.`
      );
    } catch (err: any) {
      setMessage(err.message || 'Failed to update co-admin status.');
    } finally {
      setBlocking(false);
    }
  }

  async function handleToggleStaffStatus(user: StaffUser) {
    setBlocking(true);
    setMessage('');

    try {
      if (user.status === 'disabled') {
        await unblockStaff(user);
      } else {
        await blockStaff(user);
      }

      await Promise.all([loadStaffList(), loadAllStaffForCoadmins()]);
      setMessage(`Staff ${user.status === 'disabled' ? 'unblocked' : 'blocked'} successfully.`);
    } catch (err: any) {
      setMessage(err.message || 'Failed to update staff status.');
    } finally {
      setBlocking(false);
    }
  }

  async function handleImageSelect(file: File) {
    try {
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.7,
        maxWidthOrHeight: 1000,
        useWebWorker: true,
      });

      setSelectedImage(compressed);
      setImagePreview(URL.createObjectURL(compressed));
    } catch (err) {
      console.error(err);
      setMessage('Failed to process image.');
    }
  }

  function handleClearImage() {
    setSelectedImage(null);

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }

    setImagePreview(null);
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();

    if (!selectedChatUser) return;

    try {
      if (selectedImage) {
        setSendingImage(true);
        await sendImageMessage(selectedChatUser.uid, selectedImage);
        handleClearImage();
      }

      if (newMessage.trim()) {
        await sendChatMessage(selectedChatUser.uid, newMessage);
        setNewMessage('');
      }
    } catch (err: any) {
      setMessage(err.message || 'Failed to send message.');
    } finally {
      setSendingImage(false);
    }
  }

  function handleUserSelect(user: AdminUser) {
    setSelectedChatUser(user);
    setNewMessage('');
    markConversationAsRead(user.uid);
  }

  async function handleOpenFirstUnreadChat() {
    let users = chatUsers;

    if (users.length === 0) {
      const coadminsList = await getCoadmins();
      const staffUsers = await getStaff();
      users = [...coadminsList, ...staffUsers];
      setChatUsers(users);
    }

    const unreadUser =
      users.find((user) => (unreadCounts[user.uid] || 0) > 0) || null;

    setActiveView('reach-out');

    if (unreadUser) {
      setSelectedChatUser(unreadUser);
      setNewMessage('');
      markConversationAsRead(unreadUser.uid);
    }
  }

  function handleChangeView(view: AdminView) {
    setActiveView(view);
    setMessage('');
    setSelectedCoadmin(null);
    setSelectedStaff(null);
    setDeleteTarget(null);
    setDeleteStaffTarget(null);

    if (view !== 'reach-out') {
      setSelectedChatUser(null);
      setNewMessage('');
    }
  }

  const sortedCoadmins = [...coadmins].sort((a: any, b: any) => {
    const aTime =
      a.createdAt?.toDate?.()?.getTime?.() ||
      a.createdAt?.getTime?.() ||
      0;

    const bTime =
      b.createdAt?.toDate?.()?.getTime?.() ||
      b.createdAt?.getTime?.() ||
      0;

    return bTime - aTime;
  });

  const sortedStaff = [...staffList].sort((a: any, b: any) => {
    const aTime =
      a.createdAt?.toDate?.()?.getTime?.() ||
      a.createdAt?.getTime?.() ||
      0;

    const bTime =
      b.createdAt?.toDate?.()?.getTime?.() ||
      b.createdAt?.getTime?.() ||
      0;

    return bTime - aTime;
  });

  const sortedPlayers = [...players].sort((a: any, b: any) => {
    const aTime = a.createdAt?.toDate?.()?.getTime?.() || a.createdAt?.getTime?.() || 0;
    const bTime = b.createdAt?.toDate?.()?.getTime?.() || b.createdAt?.getTime?.() || 0;
    return bTime - aTime;
  });

  const adminPresenceUids = useMemo(() => {
    const s = new Set<string>();
    for (const u of coadmins) s.add(u.uid);
    for (const u of staffList) s.add(u.uid);
    for (const u of players) s.add(u.uid);
    for (const u of chatUsers) s.add(u.uid);
    return Array.from(s);
  }, [coadmins, staffList, players, chatUsers]);

  const adminOnlineByUid = usePresenceOnlineMap(adminPresenceUids);

  const menuItems: (NavigationItem & { view: AdminView })[] = [
    { label: 'Dashboard', view: 'dashboard' },
    { label: 'Create Co-admin', view: 'create-coadmin' },
    { label: 'View Co-admins', view: 'view-coadmins' },
    { label: 'Add Staff', view: 'add-staff' },
    { label: 'View Staff', view: 'view-staff' },
    { label: 'Players', view: 'players' },
    {
      label: 'Reach Out',
      view: 'reach-out',
      unread: totalUnreadCount,
      onClick: () => {
        if (totalUnreadCount > 0) {
          handleOpenFirstUnreadChat();
          return;
        }

        handleChangeView('reach-out');
      },
    },
  ];

  return (
    <ProtectedRoute allowedRoles={['admin']}>
      <RoleSidebarLayout
        title="Admin Panel"
        activeView={activeView}
        items={menuItems.map((item) => ({
          ...item,
          onClick: item.onClick ?? (() => handleChangeView(item.view)),
        }))}
        footer={<LogoutButton />}
      >
          {message && (
            <div className="mb-4 rounded-2xl bg-white/10 p-3 text-sm text-neutral-300">
              {message}
            </div>
          )}

          {activeView === 'dashboard' && (
            <div>
              <DashboardView
                coadminCount={coadmins.length}
                staffCount={staffList.length}
                unreadCount={totalUnreadCount}
              />

              <div className="mt-5 rounded-2xl border border-cyan-400/25 bg-cyan-950/20 p-5">
                <h3 className="text-lg font-bold text-cyan-100">
                  Owner Profit Calculator (USD)
                </h3>
                <p className="mt-1 text-xs text-cyan-100/70">
                  AED→USD: {AED_TO_USD} | NPR→USD: {NPR_TO_USD}
                </p>

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="text-sm text-cyan-50/90">
                    Monthly net (USD)
                    <input
                      type="number"
                      value={monthlyNetUsdInput}
                      onChange={(e) => setMonthlyNetUsdInput(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-white outline-none focus:border-cyan-300/60"
                    />
                  </label>
                  <label className="text-sm text-cyan-50/90">
                    Owner share (%)
                    <input
                      type="number"
                      value={ownerSharePercentInput}
                      onChange={(e) => setOwnerSharePercentInput(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-white outline-none focus:border-cyan-300/60"
                    />
                  </label>
                  <label className="text-sm text-cyan-50/90">
                    Total staff payout (AED)
                    <input
                      type="number"
                      value={staffPayoutAedInput}
                      onChange={(e) => setStaffPayoutAedInput(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-white outline-none focus:border-cyan-300/60"
                    />
                  </label>
                  <label className="text-sm text-cyan-50/90">
                    Total carer payout (NPR)
                    <input
                      type="number"
                      value={carerPayoutNprInput}
                      onChange={(e) => setCarerPayoutNprInput(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-white outline-none focus:border-cyan-300/60"
                    />
                  </label>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-cyan-100/70">Owner share (USD)</p>
                    <p className="mt-1 text-xl font-bold text-white">
                      ${profitModel.ownerShareUsd.toFixed(2)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-cyan-100/70">Staff payout in USD</p>
                    <p className="mt-1 text-xl font-bold text-white">
                      ${profitModel.staffUsd.toFixed(2)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <p className="text-xs text-cyan-100/70">Carer payout in USD</p>
                    <p className="mt-1 text-xl font-bold text-white">
                      ${profitModel.carerUsd.toFixed(2)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/25 p-4">
                    <p className="text-xs text-emerald-100/70">Final owner profit (USD)</p>
                    <p className="mt-1 text-xl font-bold text-emerald-100">
                      ${profitModel.ownerFinalProfitUsd.toFixed(2)}
                    </p>
                  </div>
                </div>

                {(profitModel.isNegativeProfit ||
                  profitModel.payoutExceedsOwnerShare ||
                  profitModel.payoutOverHalfShare) && (
                  <div className="mt-4 rounded-xl border border-rose-500/40 bg-rose-950/40 p-4 text-sm text-rose-100">
                    <p className="font-semibold text-rose-200">Profit Warning</p>
                    {profitModel.isNegativeProfit && (
                      <p className="mt-1">- Owner final profit is below 0.</p>
                    )}
                    {profitModel.payoutExceedsOwnerShare && (
                      <p className="mt-1">
                        - Staff + carer payout exceeds owner share.
                      </p>
                    )}
                    {profitModel.payoutOverHalfShare && (
                      <p className="mt-1">
                        - Total payout is more than 50% of owner share.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {totalUnreadCount > 0 && (
                <button
                  onClick={handleOpenFirstUnreadChat}
                  className="mt-4 rounded-2xl bg-red-500 px-4 py-3 text-sm font-bold text-white hover:bg-red-600"
                >
                  Open unread chat
                </button>
              )}
            </div>
          )}

          {activeView === 'create-coadmin' && (
            <CreateUserForm
              title="Create Co-admin"
              buttonLabel="Create Co-admin"
              loadingLabel="Creating..."
              username={coadminUsername}
              password={coadminPassword}
              loading={loading}
              onUsernameChange={setCoadminUsername}
              onPasswordChange={setCoadminPassword}
              onSubmit={handleCreateCoadmin}
            />
          )}

          {activeView === 'view-coadmins' && (
            <UserManagementView
              title="Co-admins"
              emptyText="No co-admins found."
              selectText="Select a co-admin to manage."
              deleteTitle="Delete co-admin?"
              deleteMessage="Are you sure you want to delete"
              users={sortedCoadmins}
              selectedUser={selectedCoadmin}
              deleteTarget={deleteTarget}
              loadingList={loadingList}
              loading={loading}
              unreadCounts={unreadCounts}
              imagePreview={imagePreview}
              sendingImage={sendingImage}
              onSelectUser={setSelectedCoadmin}
              onSetDeleteTarget={setDeleteTarget}
              onDelete={handleDeleteCoadmin}
              onToggleBlock={handleToggleCoadminStatus}
              blocking={blocking}
              onlineByUid={adminOnlineByUid}
              renderSelectedExtras={(coadmin) => {
                const relatedStaff = [...allStaffForCoadmins]
                  .filter((staff) => belongsToCoadmin(staff, coadmin.uid))
                  .sort((a: any, b: any) => {
                    const aTime =
                      a.createdAt?.toDate?.()?.getTime?.() ||
                      a.createdAt?.getTime?.() ||
                      0;
                    const bTime =
                      b.createdAt?.toDate?.()?.getTime?.() ||
                      b.createdAt?.getTime?.() ||
                      0;

                    return bTime - aTime;
                  });

                return (
                  <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                    <h3 className="text-sm font-bold text-white">
                      Staff under this co-admin ({relatedStaff.length})
                    </h3>

                    {relatedStaff.length === 0 ? (
                      <p className="mt-2 text-sm text-neutral-400">No staff linked yet.</p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {relatedStaff.map((staff) => (
                          <div
                            key={staff.uid}
                            className="rounded-xl border border-white/10 bg-white/5 p-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-white">Staff Account</p>
                                <p className="text-xs text-neutral-400">
                                  Status: {staff.status}
                                </p>
                              </div>

                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  disabled={blocking || loading}
                                  onClick={() => void handleToggleStaffStatus(staff)}
                                  className="rounded-lg bg-yellow-500/20 px-3 py-1.5 text-xs font-semibold text-yellow-300 hover:bg-yellow-500/30 disabled:opacity-60"
                                >
                                  {staff.status === 'disabled' ? 'Unblock' : 'Block'}
                                </button>
                                <button
                                  type="button"
                                  disabled={loading}
                                  onClick={() => void handleDeleteSpecificStaff(staff)}
                                  className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/30 disabled:opacity-60"
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
            />
          )}

          {activeView === 'add-staff' && (
            <CreateUserForm
              title="Add Staff"
              buttonLabel="Create Staff"
              loadingLabel="Creating..."
              username={staffUsername}
              password={staffPassword}
              loading={loading}
              onUsernameChange={setStaffUsername}
              onPasswordChange={setStaffPassword}
              onSubmit={handleCreateStaff}
            />
          )}

          {activeView === 'view-staff' && (
            <UserManagementView
              title="Staff"
              emptyText="No staff found."
              selectText="Select a staff member to manage."
              deleteTitle="Delete staff?"
              deleteMessage="Are you sure you want to delete"
              users={sortedStaff}
              selectedUser={selectedStaff}
              deleteTarget={deleteStaffTarget}
              loadingList={loadingList}
              loading={loading}
              unreadCounts={unreadCounts}
              imagePreview={imagePreview}
              sendingImage={sendingImage}
              onSelectUser={setSelectedStaff}
              onSetDeleteTarget={setDeleteStaffTarget}
              onDelete={handleDeleteStaff}
              onToggleBlock={handleToggleStaffStatus}
              blocking={blocking}
              onlineByUid={adminOnlineByUid}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
            />
          )}

          {activeView === 'players' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-3xl font-bold">Players</h2>
                <p className="mt-2 text-sm text-neutral-400">
                  Active players and archived players with recreate support.
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h3 className="mb-4 text-xl font-bold">Active Players ({sortedPlayers.length})</h3>

                {loadingList ? (
                  <p className="text-sm text-neutral-400">Loading...</p>
                ) : sortedPlayers.length === 0 ? (
                  <p className="text-sm text-neutral-400">No active players found.</p>
                ) : (
                  <div className="space-y-3">
                    {sortedPlayers.map((player) => (
                      <div
                        key={player.uid}
                        className="rounded-xl border border-white/10 bg-black/30 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <p className="flex flex-wrap items-center gap-2 text-lg font-semibold text-white">
                              <OnlineIndicator
                                online={Boolean(adminOnlineByUid[player.uid])}
                                sizeClassName="h-3 w-3"
                              />
                              <span>{player.username}</span>
                            </p>
                            <p className="text-sm text-neutral-400">UID: {player.uid}</p>
                            <p className="text-sm text-neutral-400">
                              Coin: {Number((player as any).coin || 0)} / Cash:{' '}
                              {Number((player as any).cash || 0)}
                            </p>
                            <p className="text-sm text-neutral-400">
                              Status: <span className="text-white">{player.status}</span>
                            </p>
                          </div>

                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => void handleDeletePlayer(player)}
                            className="rounded-lg bg-red-500/20 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/30 disabled:opacity-60"
                          >
                            Archive/Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/5 p-5">
                <h3 className="mb-4 text-xl font-bold text-yellow-200">
                  Deleted Player Archive ({deletedPlayers.length})
                </h3>

                {deletedPlayers.length === 0 ? (
                  <p className="text-sm text-yellow-100/70">No deleted players in archive.</p>
                ) : (
                  <div className="space-y-3">
                    {deletedPlayers.map((player) => (
                      <div
                        key={player.uid}
                        className="rounded-xl border border-yellow-500/20 bg-black/40 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <p className="text-lg font-semibold text-white">{player.username}</p>
                            <p className="text-sm text-yellow-100/70">UID: {player.uid}</p>
                            <p className="text-sm text-yellow-100/70">
                              Coin: {Number(player.coin || 0)} / Cash: {Number(player.cash || 0)}
                            </p>
                            <p className="text-sm text-yellow-100/70">
                              Deleted At: {player.deletedAt || 'Unknown'}
                            </p>
                          </div>

                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => void handleRecreatePlayer(player)}
                              className="rounded-lg bg-green-500/20 px-3 py-2 text-sm font-semibold text-green-300 hover:bg-green-500/30 disabled:opacity-60"
                            >
                              Recreate
                            </button>
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => void handleDeletePlayerForever(player)}
                              className="rounded-lg bg-red-500/20 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/30 disabled:opacity-60"
                            >
                              Delete Forever
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeView === 'reach-out' && (
            <ReachOutView
              chatUsers={chatUsers}
              selectedChatUser={selectedChatUser}
              messages={messages}
              newMessage={newMessage}
              unreadCounts={unreadCounts}
              imagePreview={imagePreview}
              sendingImage={sendingImage}
              messagesScrollRef={reachOutScrollRef}
              hasMoreOlderMessages={pagedReachOut.hasMoreOlder}
              loadingOlderMessages={pagedReachOut.loadingOlder}
              onLoadOlderMessages={pagedReachOut.loadOlder}
              onSelectUser={handleUserSelect}
              onMessageChange={setNewMessage}
              onSendMessage={handleSendMessage}
              onImageSelect={handleImageSelect}
              onClearImage={handleClearImage}
              onlineByUid={adminOnlineByUid}
            />
          )}
      </RoleSidebarLayout>
    </ProtectedRoute>
  );
}
